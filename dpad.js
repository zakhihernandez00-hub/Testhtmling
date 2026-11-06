function simulateKeyEvent(eventType, keyCode, charCode) {
    var e = document.createEventObject ? document.createEventObject() : document.createEvent("Events");
    if (e.initEvent) e.initEvent(eventType, true, true);

    e.keyCode = keyCode;
    e.which = keyCode;
    e.charCode = charCode;

    // Dispatch directly to Emscripten's html5.h API (use this if page uses emscripten/html5.h event handling):
    if (typeof JSEvents !== 'undefined' && JSEvents.eventHandlers && JSEvents.eventHandlers.length > 0) {
        for(var i = 0; i < JSEvents.eventHandlers.length; ++i) {
            if ((JSEvents.eventHandlers[i].target == Module['canvas'] || JSEvents.eventHandlers[i].target == window)
                && JSEvents.eventHandlers[i].eventTypeString == eventType) {
                JSEvents.eventHandlers[i].handlerFunc(e);
            }
        }
    } else {
        // Dispatch to browser for real (use this if page uses SDL or something else for event handling):
        Module['canvas'].dispatchEvent ? Module['canvas'].dispatchEvent(e) : Module['canvas'].fireEvent("on" + eventType, e);
    }
}

// Mappings
const keyMap = {};
const keysDown = {};

/** Add virtual key binding */
function bindKey(elem, key) {
    keyMap[elem] = key;
    const ne = document.getElementById(elem);

    ne.addEventListener('touchstart', function(e) {
        e.preventDefault();
        simulateKeyEvent('keydown', key);
        keysDown[e.target.id] = elem;
    });
    ne.addEventListener('touchend', function(e) {
        e.preventDefault();
        if (keysDown[e.target.id] && keyMap[keysDown[e.target.id]]) {
            simulateKeyEvent('keyup', keyMap[keysDown[e.target.id]]);
        }
        keysDown[e.target.id] = 0;
    });

    ne.addEventListener('touchmove', function(event) {
        const myLocation = event.changedTouches[0];
        const realTarget = document.elementFromPoint(myLocation.clientX, myLocation.clientY).id;
        const origTarget = keysDown[myLocation.target.id];

        if (origTarget !== realTarget) {
            if (origTarget) {
                simulateKeyEvent('keyup', keyMap[origTarget]);
                keysDown[myLocation.target.id] = 0;
            }
            if (keyMap[realTarget]) {
                simulateKeyEvent('keydown', keyMap[realTarget]);
                keysDown[myLocation.target.id] = realTarget;
            }
        }
    });
}

function is_touch_device() {
    try {
        document.createEvent("TouchEvent");
        return true;
    } catch (e) {
        return false;
    }
}

