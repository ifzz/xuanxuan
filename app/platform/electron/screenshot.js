import RecordRTC from "recordrtc";
import {desktopCapturer, screen as Screen, Remote} from 'electron';
import ui from './ui';
import Image from './image';
import env from './env';
import Lang from 'Lang';
import RemoteEvents from './remote';

/* This is NEEDED because RecordRTC is badly written */
global.html2canvas = (canvas, obj) => {
    obj.onrendered(canvas);
};

const getStream = sourceId => {
    return new Promise((resolve, reject) => {
        desktopCapturer.getSources({ types: ['screen'] }, (error, sources) => {
            if (error) {
                reject(error);
                return;
            }

            const display = getDisplay(sourceId);
            const displayIndex = Screen.getAllDisplays().findIndex(item => item.id === sourceId);

            navigator.webkitGetUserMedia({
                audio: false,
                video: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: sources[displayIndex].id,
                        maxWidth: display.size.width,
                        maxHeight: display.size.height,
                        minWidth: display.size.width,
                        minHeight: display.size.height
                    }
                }
            }, resolve, reject);
        });
    });
};

const getVideo = stream => {
    const video = document.createElement('video');
    video.autoplay = true;
    video.src = URL.createObjectURL(stream);
    return new Promise(resolve => {
        video.addEventListener('playing', () => {
            resolve(video);
        });
    });
};

const getCanvas = (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
};

const drawFrame = ({ ctx, video, x, y, width, height, availTop = screen.availTop }) => {
    ctx.drawImage(video, x, y, width, height, 0, -availTop, width, height);
};

const getFrameImage = canvas => {
    return canvas.toDataURL();
};

const getDisplay = id => {
    if(id) return Screen.getAllDisplays().find(item => item.id === id);
    else return Screen.getPrimaryDisplay();
};

const getLoop = fn => {
    let requestId;
    const callFn = () => {
        requestId = requestAnimationFrame(callFn);
        fn();
    };
    callFn();
    return () => {
        cancelAnimationFrame(requestId);
    };
};

const startRecording = ({ canvas, video, x, y, width, height, availTop }) => {
    const recorder = RecordRTC(canvas, { type: 'canvas' });
    const ctx = canvas.getContext('2d');
    const stopLoop = getLoop(() => drawFrame({ ctx, video, x, y, width, height, availTop }));

    recorder.startRecording();

    return {
        stop() {
            return new Promise(resolve => {
                stopLoop();
                recorder.stopRecording(() => {
                    recorder.getDataURL(url => resolve({ url, width, height }));
                });
            });
        },
        pause() {
            recorder.pauseRecording();
        },
        resume() {
            recorder.resumeRecording();
        }
    };
};

const takeScreenshot = ({ x = 0, y = 0, width = 0, height = 0, sourceId = 0 }) => {
    let display = getDisplay(sourceId);
    const availTop = screen.availTop - display.bounds.y;
    sourceId = display.id;

    if(!width) width   = display.bounds.width;
    if(!height) height = display.bounds.height;

    return getStream(sourceId)
        .then(getVideo)
        .then(video => {
            const canvas = getCanvas(width, height);
            const ctx = canvas.getContext('2d');
            drawFrame({ ctx, video, x, y, width, height, availTop });
            return getFrameImage(canvas);
        });
};

const takeAllScreenshots = (options) => {
    if(!options) {
        options = Screen.getAllDisplays().map(item => {
            return {
                x: 0,
                y: 0,
                width: item.bounds.width,
                height: item.bounds.height,
                sourceId: item.id
            };
        });
    }
    if(Array.isArray(options)) {
        return Promise.all(options.map(option => {
            return takeScreenshot(option);
        }));
    } else {
        return takeScreenshot(options);
    }
};

const captureVideo = ({ x, y, width, height, sourceId }) => {
    let display = getDisplay(sourceId);
    const availTop = screen.availTop - display.bounds.y;
    sourceId = display.id;
    return getStream(sourceId)
        .then(getVideo)
        .then(video => {
            const canvas = getCanvas(width, height);
            return startRecording({ canvas, video, x, y, width, height, availTop });
        });
};

const saveScreenshotImage = (options, filePath, hideCurrentWindow) => {
    if(!options) {
        options = {};
    }
    let processImage = base64Image => {
        if(hideCurrentWindow) {
            ui.browserWindow.show();
        }
        return Image.saveImage(base64Image, filePath);
    };
    if(hideCurrentWindow && ui.browserWindow.isVisible()) {
        if(env.isWindowsOS) {
            let hideWindowTask = () => {
                ui.browserWindow.hide();
                return new Promise((resolve, reject) => {
                    setTimeout(resolve, 600);
                });
            };
            return hideWindowTask().then(() => {
                return takeScreenshot(options);
            }).then(processImage);
        }
        ui.browserWindow.hide();
    }
    return takeScreenshot(options).then(processImage);
};

const openCaptureWindow = (filePath, screenSources = 0, hideCurrentWindow = false) => {
    let openCaptureScreenWindow = (file, display) => {
        return new Promise((resolve, reject) => {
            let captureWindow = new Remote.BrowserWindow({
                x: display ? display.bounds.x : 0,
                y: display ? display.bounds.y : 0,
                width: display ? display.bounds.width : screen.width,
                height: display ? display.bounds.height : screen.height,
                alwaysOnTop: !DEBUG,
                fullscreen: true,
                frame: true,
                show: false,
                title: Lang.string('chat.captureScreen') + ' - ' + display.id,
                titleBarStyle: 'hidden',
                resizable: false,
            });
            if (DEBUG) {
                captureWindow.openDevTools();
            }
            captureWindow.loadURL(`file://${ui.appRoot}/capture-screen.html#` + encodeURIComponent(file.path));
            captureWindow.webContents.on('did-finish-load', () => {
                captureWindow.show();
                captureWindow.focus();
                resolve(captureWindow);
            });
        });
    };
    if(screenSources === 'all') {
        let displays = Screen.getAllDisplays();
        screenSources = displays.map(display => {
            display.sourceId = display.id;
            return display;
        });
    }
    if(!Array.isArray(screenSources)) {
        screenSources = [screenSources];
    }
    hideCurrentWindow = hideCurrentWindow && ui.browserWindow.isVisible();
    return new Promise((resolve, reject) => {
        let captureScreenWindows = [];
        RemoteEvents.ipcOnce(RemoteEvents.EVENT.capture_screen, (e, image) => {
            if(captureScreenWindows) {
                captureScreenWindows.forEach(captureWindow => {
                    captureWindow.close();
                });
            }
            if(hideCurrentWindow) {
                ui.browserWindow.show();
                ui.browserWindow.focus();
            }
            if(image) {
                Image.saveImage(image.data, filePath).then(image => {
                    if(image && image.path) {
                        clipboard.writeImage(Image.createFromPath(image.path));
                    }
                    resolve(image);
                }).catch(reject);
            } else {
                if(DEBUG) console.log('No capture image.');
            }
        });
        let takeScreenshots = () => {
            return Promise.all(screenSources.map(screenSource => {
                return saveScreenshotImage(screenSource, '').then(file => {
                    return openCaptureScreenWindow(file, screenSource).then(captureWindow => {
                        captureScreenWindows.push(captureWindow);
                    });
                });
            }));
        };
        if(hideCurrentWindow) {
            ui.browserWindow.hide();
            setTimeout(() => {
                takeScreenshots();
            }, env.isWindowsOS ? 600 : 0);
        } else {
            takeScreenshots();
        }
    });
};

export default {
    takeScreenshot,
    captureVideo,
    takeAllScreenshots,
    saveScreenshotImage,
    openCaptureScreenWindow
};
