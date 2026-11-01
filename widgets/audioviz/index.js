import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import { connectTimerCleanup, createWidgetContainer, registerWidgetCleanup } from '../../shell/widgetUIUtils.js';
import { resolveWidgetBackgroundColor, resolveWidgetForegroundColor, buildBaseWidgetStyle } from '../../utils/widgetUtils.js';
import { isActorDestroyed, watchActorLifecycle } from '../../utils/actorLifecycle.js';

const DEFAULT_FPS = 20;
const MAX_FPS = 60;
const RESTART_MIN_S = 3;
const RESTART_MAX_S = 60;
const KILL_GRACE_S = 2;
const RESIZE_DEBOUNCE_MS = 250;
const SIGTERM = 15;
const PADDING_PX = 8;
const MIN_FONT_PX = 4;
const CHAR_WIDTH_EM = 0.6;
const LINE_HEIGHT_EM = 1.3;
const ROW_SEPARATOR = '|';
const STATUS_PREFIX = '!';
const TARGET_FONT_PX = 11;
const MIN_BARS = 4;
const MAX_BARS = 128;
const MIN_ROWS = 2;
const MAX_ROWS = 64;
const NODE_FALLBACK_PATHS = ['/usr/bin/node', '/usr/local/bin/node', '/usr/bin/nodejs', '/snap/bin/node'];

let cachedNodePath = null;

function isExecutable(path) {
    return !!path && GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE) && !GLib.file_test(path, GLib.FileTest.IS_DIR);
}

function findNode(widgetData) {
    if (isExecutable(widgetData.nodePath)) return widgetData.nodePath;
    if (isExecutable(cachedNodePath)) return cachedNodePath;
    const candidates = [
        GLib.find_program_in_path('node'),
        GLib.find_program_in_path('nodejs'),
        `${GLib.get_home_dir()}/.local/bin/node`,
        ...NODE_FALLBACK_PATHS,
    ];
    cachedNodePath = candidates.find(isExecutable) || null;
    return cachedNodePath;
}

function resolveVizStyle(widgetData, width, height) {
    if (widgetData.vizStyle && widgetData.vizStyle !== 'auto')
        return widgetData.vizStyle;
    if (widgetData.vizType && widgetData.vizType !== 'auto')
        return widgetData.vizType;
    if (width >= height * 1.6)
        return 'bars';
    if (height > width * 1.2)
        return 'mirror';
    return 'wave';
}

function computeGrid(width, height) {
    const innerW = Math.max(0, (Number(width) || 0) - 2 * PADDING_PX);
    const innerH = Math.max(0, (Number(height) || 0) - 2 * PADDING_PX);
    const fitColumns = innerW / (CHAR_WIDTH_EM * TARGET_FONT_PX);
    return {
        bars: Math.max(MIN_BARS, Math.min(MAX_BARS, Math.floor((fitColumns + 1) / 3))),
        rows: Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.floor(innerH / (LINE_HEIGHT_EM * TARGET_FONT_PX)))),
    };
}

export function createAudioVizNode(widgetData, width, height, xPosition, yPosition, isDynamicColor, isDynamicImage) {
    const extensionPath = widgetData.extensionPath || '';
    const fps = Math.min(MAX_FPS, Math.max(1, Math.floor(Number(widgetData.fps)) || DEFAULT_FPS));
    const helperPath = `${extensionPath}/widgets/audioviz/ascii_frames.js`;
    const asciiChar = (widgetData.asciiChar && String(widgetData.asciiChar).trim() !== '')
        ? Array.from(String(widgetData.asciiChar).trim())[0]
        : (widgetData.ascii ? '#' : '\u2588');

    const widgetNode = createWidgetContainer(widgetData, width, height, xPosition, yPosition);
    widgetNode.style = `
        background-color: ${resolveWidgetBackgroundColor(widgetData)};
        color: ${resolveWidgetForegroundColor(widgetData)};
        ${buildBaseWidgetStyle(widgetData)}
    `;

    const layout = watchActorLifecycle(new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_expand: true,
        style: `padding: ${PADDING_PX}px;`,
        x: 0,
        y: 0,
        width: widgetNode.width,
        height: widgetNode.height,
    }));

    const label = new St.Label({
        text: '',
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    label.clutter_text.single_line_mode = false;
    label.clutter_text.line_wrap = false;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    layout.add_child(label);
    widgetNode.add_child(layout);

    const currentSize = () => {
        try {
            return [widgetNode.get_width() || width, widgetNode.get_height() || height];
        } catch (_e) {
            return [width, height];
        }
    };

    let grid = computeGrid(...currentSize());

    const textColor = () => {
        const accent = widgetData.globalAccentColor || widgetData.accentColor;
        return (typeof accent === 'string' && accent.trim() !== '')
            ? accent
            : resolveWidgetForegroundColor(widgetData);
    };

    let lastFontPx = 0;
    const fitFont = () => {
        try {
            if (isActorDestroyed(label)) return;
            const [w, h] = currentSize();
            const columns = grid.bars * 3 - 1;
            const availW = Math.max(0, w - 2 * PADDING_PX);
            const availH = Math.max(0, h - 2 * PADDING_PX);
            const byWidth = availW / (columns * CHAR_WIDTH_EM);
            const byHeight = availH / (grid.rows * LINE_HEIGHT_EM);
            const fontPx = Math.max(MIN_FONT_PX, Math.floor(Math.min(byWidth, byHeight)));
            if (fontPx === lastFontPx) return;
            label.style = `font-family: monospace; font-size: ${fontPx}px; color: ${textColor()};`;
            lastFontPx = fontPx;
        } catch (e) {
            console.error('audioviz: fitFont failed:', e);
        }
    };

    const showText = text => {
        if (!isActorDestroyed(label) && label.text !== text) label.text = text;
    };

    const state = { timerId: null };
    let proc = null;
    let cancellable = null;
    let runningKey = '';
    let restartDelay = RESTART_MIN_S;
    let resizeTimerId = 0;
    let pausedByUnmap = false;
    const pendingKills = new Map();

    const killProc = p => {
        try { p.send_signal(SIGTERM); } catch (_e) { return; }
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, KILL_GRACE_S, () => {
            pendingKills.delete(id);
            try { p.force_exit(); } catch (_e) { /* already gone */ }
            return GLib.SOURCE_REMOVE;
        });
        pendingKills.set(id, p);
    };

    const stopProcess = () => {
        if (cancellable) {
            cancellable.cancel();
            cancellable = null;
        }
        if (proc) {
            killProc(proc);
            proc = null;
        }
        runningKey = '';
    };

    const scheduleRestart = () => {
        if (state.timerId || isActorDestroyed(widgetNode)) return;
        const delay = restartDelay;
        restartDelay = Math.min(restartDelay * 2, RESTART_MAX_S);
        state.timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            state.timerId = null;
            if (isActorDestroyed(widgetNode) || pausedByUnmap || proc) return GLib.SOURCE_REMOVE;
            startProcess();
            return GLib.SOURCE_REMOVE;
        });
    };

    const handleHelperGone = thisProc => {
        if (proc !== thisProc) return;
        proc = null;
        runningKey = '';
        scheduleRestart();
    };

    const startProcess = () => {
        stopProcess();
        if (isActorDestroyed(widgetNode)) return;

        const [w, h] = currentSize();
        grid = computeGrid(w, h);
        fitFont();
        const vizStyle = resolveVizStyle(widgetData, w, h);

        const nodePath = findNode(widgetData);
        if (!nodePath) {
            showText('Node.js not found\ninstall nodejs');
            scheduleRestart();
            return;
        }
        if (!GLib.file_test(helperPath, GLib.FileTest.EXISTS)) {
            showText('audio helper missing');
            console.error(`audioviz: helper not found at ${helperPath}`);
            scheduleRestart();
            return;
        }

        let thisProc;
        try {
            const argv = [
                nodePath, '--max-old-space-size=32', helperPath, '--stream',
                '--bars', String(grid.bars), '--rows', String(grid.rows),
                '--fps', String(fps), '--style', vizStyle, '--char', asciiChar,
            ];
            thisProc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.error('audioviz: failed to start helper:', e);
            showText('audio helper\nfailed to start');
            scheduleRestart();
            return;
        }

        proc = thisProc;
        runningKey = `${grid.bars}x${grid.rows}:${vizStyle}`;
        const thisCancellable = new Gio.Cancellable();
        cancellable = thisCancellable;
        const stream = new Gio.DataInputStream({
            base_stream: thisProc.get_stdout_pipe(),
            close_base_stream: true,
        });

        const readNext = () => {
            stream.read_line_async(GLib.PRIORITY_DEFAULT, thisCancellable, (s, res) => {
                if (thisCancellable.is_cancelled() || isActorDestroyed(widgetNode)) return;

                let line;
                try {
                    [line] = s.read_line_finish_utf8(res);
                } catch (e) {
                    if (e instanceof Gio.IOErrorEnum && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
                    console.error('audioviz: read error:', e);
                    handleHelperGone(thisProc);
                    return;
                }

                if (line === null) {                       
                    handleHelperGone(thisProc);
                    return;
                }

                if (line.startsWith(STATUS_PREFIX)) {
                    showText(line.slice(STATUS_PREFIX.length).split(ROW_SEPARATOR).join('\n'));
                } else {
                    restartDelay = RESTART_MIN_S;
                    showText(line.split(ROW_SEPARATOR).join('\n'));
                }

                readNext();
            });
        };
        readNext();
    };

    const scheduleResizeCheck = () => {
        if (resizeTimerId) GLib.source_remove(resizeTimerId);
        resizeTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESIZE_DEBOUNCE_MS, () => {
            resizeTimerId = 0;
            if (isActorDestroyed(widgetNode) || pausedByUnmap) return GLib.SOURCE_REMOVE;
            const [w, h] = currentSize();
            const g = computeGrid(w, h);
            const key = `${g.bars}x${g.rows}:${resolveVizStyle(widgetData, w, h)}`;
            if (key !== runningKey) {
                restartDelay = RESTART_MIN_S;
                startProcess();
            }
            return GLib.SOURCE_REMOVE;
        });
    };

    widgetNode.connect('notify::width', () => {
        if (isActorDestroyed(layout)) return;
        layout.set_width(Math.max(0, currentSize()[0]));
        fitFont();
        scheduleResizeCheck();
    });
    widgetNode.connect('notify::height', () => {
        if (isActorDestroyed(layout)) return;
        layout.set_height(Math.max(0, currentSize()[1]));
        fitFont();
        scheduleResizeCheck();
    });

    widgetNode.connect('notify::mapped', () => {
        if (isActorDestroyed(widgetNode)) return;
        if (widgetNode.mapped) {
            if (!pausedByUnmap) return;          
            pausedByUnmap = false;
            restartDelay = RESTART_MIN_S;
            startProcess();
        } else {
            pausedByUnmap = true;
            stopProcess();
        }
    });

    fitFont();
    startProcess();

    connectTimerCleanup(widgetNode, state);
    registerWidgetCleanup(widgetNode, () => {
        if (resizeTimerId) {
            GLib.source_remove(resizeTimerId);
            resizeTimerId = 0;
        }
        stopProcess();
        for (const id of pendingKills.keys()) GLib.source_remove(id);
        pendingKills.clear();
    });

    return widgetNode;
}