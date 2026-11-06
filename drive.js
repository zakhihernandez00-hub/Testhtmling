// mkxp-web asset & save-file driver (customized for an RGSS2 / VX game)

window.fileAsyncCache = {};

window.getMappingKey = function(file) {
    return file.toLowerCase().replace(/\\/g, "/").replace(/^\.\//, "").replace(new RegExp("\\.[^/.]+$"), "");
};

function mappingPathParts(mappingValue) {
    const clean = mappingValue.split("?")[0];
    const slash = clean.lastIndexOf("/");
    return {
        dir: "/game/" + (slash >= 0 ? clean.substring(0, slash) : ""),
        name: slash >= 0 ? clean.substring(slash + 1) : clean,
    };
}

// Called from C++ (via Asyncify) whenever the engine needs a file.
window.loadFileAsync = function(fullPath, bitmap, callback) {
    callback = callback || (() => {});

    const mappingKey = getMappingKey(fullPath);
    const mappingValue = mapping[mappingKey];

    if (window.fileAsyncCache.hasOwnProperty(mappingKey)) return callback();

    // Folders and unknown files: nothing to fetch
    if (!mappingValue || mappingValue.endsWith("h=")) {
        return callback();
    }

    if (window.setBusy) window.setBusy();

    const parts = mappingPathParts(mappingValue);

    getLazyAsset("gameasync/" + mappingValue, parts.name, (data) => {
        const done = () => {
            window.fileAsyncCache[mappingKey] = 1;
            const seedT = window.saveSeedTimes && window.saveSeedTimes[mappingKey];
            if (seedT) {
                try { FS.utime(parts.dir + "/" + parts.name, seedT, seedT); } catch (e) {}
            }
            if (window.setNotBusy) window.setNotBusy();
            if (window.fileLoadedAsync) window.fileLoadedAsync(fullPath);
            callback();
        };

        if (!data) { done(); return; }

        FS.createPreloadedFile(parts.dir, parts.name, new Uint8Array(data), true, true, done,
            (e) => { console.error("Failed to prepare", fullPath, e); done(); },
            false, false,
            () => { try { FS.unlink(parts.dir + "/" + parts.name); } catch (err) {} });
    });
};

// ---------------------------------------------------------------------------
// Save files (persisted in IndexedDB via localForage)
// ---------------------------------------------------------------------------

window.saveFile = function(filename, localOnly) {
    const fpath = '/game/' + filename;
    if (!FS.analyzePath(fpath).exists) return;

    window.fileAsyncCache[getMappingKey(filename)] = 1;
    (window.sessionWrites = window.sessionWrites || {})[filename] = 1;

    const buf = FS.readFile(fpath);
    localforage.setItem(namespace + filename, buf);

    localforage.getItem(namespace, function(err, res) {
        if (err || !res) res = {};
        res[filename] = { t: Number(FS.stat(fpath).mtime) };
        localforage.setItem(namespace, res);
    });

    if (window.onSaveWritten) window.onSaveWritten(filename);
};

window.listStoredSaves = function(cb) {
    localforage.getItem(namespace, function(err, folder) {
        cb((err || !folder) ? {} : folder);
    });
};

var loadFiles = function() {
    localforage.getItem(namespace, function(err, folder) {
        if (err || !folder) return;
        console.log('Locally stored savefiles:', Object.keys(folder).length);

        Object.keys(folder).forEach((key) => {
            const meta = folder[key];
            localforage.getItem(namespace + key, (err, res) => {
                if (err || !res) return;

                const mkey = getMappingKey(key);
                // The game already wrote this file during this session
                if (window.sessionWrites && window.sessionWrites[key]) return;

                const fpath = '/game/' + key;
                const dir = fpath.substring(0, fpath.lastIndexOf('/'));
                try { FS.mkdirTree(dir); } catch (e) {}
                FS.writeFile(fpath, res);
                window.fileAsyncCache[mkey] = 1;

                if (Number.isFinite(meta.t)) {
                    try { FS.utime(fpath, meta.t, meta.t); } catch (e) {}
                }
            });
        });
    }, console.error);
};

var createDummies = function() {
    FS.mkdir('/game');

    for (var i = 0; i < mappingArray.length; i++) {
        const file = mappingArray[i][1];
        const filename = '/game/' + file.split("?")[0];

        if (file.endsWith('h=')) {
            try { FS.mkdir(filename); } catch (e) {}
        } else if (window.saveSeedTimes && window.saveSeedTimes[mappingArray[i][0]]) {
            // Bundled save: placeholder until the game actually opens it
            FS.writeFile(filename, '1');
            const t = window.saveSeedTimes[mappingArray[i][0]];
            try { FS.utime(filename, t, t); } catch (e) {}
        } else {
            FS.writeFile(filename, '1');
        }
    }
};

// ---------------------------------------------------------------------------
// Background prefetching (warms the in-memory FS ahead of time)
// ---------------------------------------------------------------------------

function preloadList(jsonArray) {
    jsonArray.forEach((file) => {
        const mappingKey = getMappingKey(file);
        const mappingValue = mapping[mappingKey];
        if (!mappingValue || window.fileAsyncCache[mappingKey]) return;
        if (window.saveSeedTimes && window.saveSeedTimes[mappingKey]) return;

        const parts = mappingPathParts(mappingValue);

        getLazyAsset("gameasync/" + mappingValue, parts.name, (data) => {
            if (!data || window.fileAsyncCache[mappingKey]) return;

            FS.createPreloadedFile(parts.dir, parts.name, new Uint8Array(data), true, true, function() {
                window.fileAsyncCache[mappingKey] = 1;
            }, console.error, false, false, () => {
                try { FS.unlink(parts.dir + "/" + parts.name); } catch (err) {}
            });
        }, true, true);
    });
}

const preloadedMaps = {};
window.fileLoadedAsync = function(file) {
    if (!(/Map\d+\.rvdata/i.test(file))) return;
    const name = file.replace(/^.*[\/\\]/, "");
    if (preloadedMaps[name]) return;
    preloadedMaps[name] = 1;

    fetch('preload/' + name + '.json')
        .then((response) => response.ok ? response.json() : [])
        .then((list) => setTimeout(() => preloadList(list), 50))
        .catch(() => {});
};

// ---------------------------------------------------------------------------
// Network fetch with progress + retry
// ---------------------------------------------------------------------------

var activeStreams = [];
var bgQueue = [];
var bgActive = 0;
const BG_MAX = 4;

function pumpBackground() {
    while (bgActive < BG_MAX && bgQueue.length) {
        const job = bgQueue.shift();
        bgActive++;
        job(() => { bgActive--; pumpBackground(); });
    }
}

function getLazyAsset(url, filename, callback, noretry, background) {
    if (background) {
        bgQueue.push((release) => fetchAsset(url, filename, (d) => { release(); callback(d); }, noretry, true));
        pumpBackground();
        return;
    }
    fetchAsset(url, filename, callback, noretry, false);
}

function fetchAsset(url, filename, callback, noretry, quiet) {
    const xhr = new XMLHttpRequest();
    xhr.responseType = "arraybuffer";
    let abortTimer = 0;
    let finished = false;

    const end = () => {
        finished = true;
        clearTimeout(abortTimer);
        if (!quiet) {
            activeStreams.splice(activeStreams.indexOf(filename), 1);
            if (window.updateProgress) window.updateProgress(activeStreams);
        }
    };

    const retry = () => {
        if (finished) return;
        xhr.abort();
        end();
        if (noretry) {
            callback(null);
        } else {
            fetchAsset(url, filename, callback, noretry, quiet);
        }
    };

    xhr.onreadystatechange = function() {
        if (xhr.readyState !== XMLHttpRequest.DONE || finished) return;
        if (xhr.status >= 200 && xhr.status < 400) {
            end();
            callback(xhr.response);
        } else if (xhr.status === 404) {
            end();
            console.error("Missing asset", url);
            callback(null);
        } else {
            setTimeout(retry, 1000);
        }
    };
    xhr.onprogress = function(event) {
        if (!quiet && window.updateProgress) window.updateProgress(activeStreams, filename, event.loaded, event.total);
        clearTimeout(abortTimer);
        abortTimer = setTimeout(retry, 15000);
    };
    xhr.open('GET', url);
    xhr.send();

    if (!quiet) {
        activeStreams.push(filename);
        if (window.updateProgress) window.updateProgress(activeStreams, filename, 0, 0);
    }

    abortTimer = setTimeout(retry, 15000);
}
