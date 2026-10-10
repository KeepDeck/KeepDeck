import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DownloadState } from "@keepdeck/plugin-api";
import { formatChord } from "../binding";
import { runtime } from "../runtime";
import { Button } from "@keepdeck/ui-kit/Button";
import { HelpPopover, InfoIcon } from "./HelpPopover";
import { downloadRows, MODELS_TEXT } from "../modelsView";
import {
  canClear,
  emptyHint,
  entryView,
  listenControl,
  modelsNotice,
  statusLine,
  TAB_TEXT,
  tabScreen,
} from "../tabView";
import { MicBlock } from "./MicBlock";
import { useMicStatus } from "./useMicStatus";
import { useMicDevices } from "./useMicDevices";
import { micPicker, standInLine } from "../microphone";

/**
 * The Voice dock tab: the log of what was heard and what was done — newest
 * first, as the controller hands it over — the mic toggle for command mode,
 * and the model manager (download-on-demand — weights are never bundled, the
 * picker IS the install surface).
 */
export function VoiceTab() {
  const { ctx, controller, downloads, models: store, bindings: bindingsStore } =
    runtime();
  const snap = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const mic = useMicStatus(controller);
  // The connected microphones, read when the tab mounts and on Refresh
  // (decision №1: on request, nothing watches in the background).
  const micList = useMicDevices(ctx);
  const picker = micPicker(micList.devices, snap.micPick);
  const bindings = useSyncExternalStore(
    bindingsStore.subscribe,
    bindingsStore.snapshot,
  );
  const dl = useSyncExternalStore(downloads.subscribe, downloads.snapshot);
  // Install state from the shared store — a delete in settings or a finished
  // download refreshes it, so this prompt appears/clears without reopening.
  const models = useSyncExternalStore(store.subscribe, store.snapshot);
  const modelsError = useSyncExternalStore(store.subscribe, store.error);
  const modelsState = { models, error: modelsError, downloading: downloads.anyActive() };
  const [helpAnchor, setHelpAnchor] = useState<HTMLElement | null>(null);
  const helpBtnRef = useRef<HTMLButtonElement | null>(null);
  // Hover intent: open after a short dwell, close after a grace period so
  // the cursor can travel from the button onto the card.
  const helpTimer = useRef<number | null>(null);
  const helpDelay = (action: () => void, ms: number) => {
    if (helpTimer.current !== null) window.clearTimeout(helpTimer.current);
    helpTimer.current = window.setTimeout(action, ms);
  };
  const helpHold = () => {
    if (helpTimer.current !== null) window.clearTimeout(helpTimer.current);
  };
  useEffect(() => helpHold, []);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Follow the newest entry. It is prepended, so "newest" is the TOP of the
  // scroller — a reader who had scrolled back into older lines is returned to
  // the fresh one, the same intent the old scroll-to-bottom served.
  useEffect(() => {
    logRef.current?.scrollTo({ top: 0 });
  }, [snap.history.length]);

  // Click-to-copy: a row copies its text on click, briefly REPLACING the row's
  // text with "Copied" (or "Copy failed" on rejection) + an accent tint. A
  // drag-select inside the SAME row also ends in a click, so the handler bails
  // when the active selection touches this row — the manual select-and-copy
  // fallback stays intact and never gets hijacked. A selection ELSEWHERE does
  // not block the copy (it belongs to another element).
  const [feedback, setFeedback] = useState<{ key: string; ok: boolean } | null>(
    null,
  );
  const feedbackTimer = useRef<number | null>(null);
  const flash = (key: string, ok: boolean) => {
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
    setFeedback({ key, ok });
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), 1200);
  };
  useEffect(
    () => () => {
      if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
    },
    [],
  );
  const copyEntry = (text: string, key: string) => {
    void ctx.services.clipboard
      .writeText(text)
      .then(() => flash(key, true))
      .catch(() => flash(key, false));
  };

  // No model installed (and none arriving): the whole surface is a prompt to
  // get one — voice can't do anything without a model. A download in flight
  // shows the strip instead, so the user sees progress here too.
  if (tabScreen(snap.phase, modelsState) === "setup") {
    return (
      <div className="voice voice__setup">
        <div className="voice__setup-title">{TAB_TEXT.setupTitle}</div>
        <div className="voice__setup-text">{TAB_TEXT.setupText}</div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void ctx.commands.execute("settings.open", {})}
        >
          {TAB_TEXT.setupAction}
        </Button>
      </div>
    );
  }

  const listen = listenControl(snap.phase, formatChord(bindings.command), modelsState);
  const status = statusLine(snap.phase, snap.mode);
  const notice = modelsNotice(modelsState);
  return (
    <div className="voice">
      <div className="voice__bar">
        <button
          type="button"
          className={`voice__mic${listen.on ? " voice__mic--on" : ""}`}
          onClick={() => (listen.on ? void controller.stop() : void controller.start("command"))}
          disabled={listen.disabled}
          title={listen.title}
        >
          {listen.label}
        </button>
        <span className="voice__spacer" />
        <button
          type="button"
          ref={helpBtnRef}
          className={`voice__info${helpAnchor ? " voice__info--on" : ""}`}
          onMouseEnter={() =>
            helpDelay(() => setHelpAnchor(helpBtnRef.current), 450)
          }
          onMouseLeave={() => helpDelay(() => setHelpAnchor(null), 150)}
          onClick={() => {
            helpHold();
            setHelpAnchor(helpAnchor ? null : helpBtnRef.current);
          }}
          aria-label={TAB_TEXT.helpLabel}
        >
          <InfoIcon />
        </button>
        {canClear(snap.phase, snap.history.length) && (
          <Button
            size="sm"
            className="voice__model-btn"
            onClick={() => controller.clearHistory()}
            title={TAB_TEXT.clearTitle}
          >
            {TAB_TEXT.clear}
          </Button>
        )}
      </div>
      {status && <div className="voice__status">{status}</div>}
      {notice && (
        <div className="voice__notice kd-selectable">
          {notice.text}
          <Button size="sm" onClick={() => void store.refresh()}>
            {MODELS_TEXT.retry}
          </Button>
        </div>
      )}
      <MicBlock
        status={mic}
        picker={picker}
        listError={micList.error}
        standIn={standInLine(snap.micPick, mic.device)}
        onChoose={(value) => void controller.chooseMicrophone(picker.pickOf(value))}
        onRefresh={micList.refresh}
      />
      {helpAnchor && (
        <HelpPopover
          anchor={helpAnchor}
          onClose={() => setHelpAnchor(null)}
          onPointerStay={helpHold}
          onPointerLeave={() => helpDelay(() => setHelpAnchor(null), 150)}
        />
      )}

      <DownloadStrip active={dl.active} />

      <div className="voice__log kd-selectable" ref={logRef}>
        {snap.history.length === 0 && (
          <div className="voice__empty">
            {emptyHint(formatChord(bindings.command), formatChord(bindings.dictation)).map((part, i) =>
              "chord" in part ? (
                <kbd key={i}>{part.chord}</kbd>
              ) : "info" in part ? (
                <span key={i} className="voice__empty-i">
                  ⓘ
                </span>
              ) : (
                part.text
              ),
            )}
          </div>
        )}
        {snap.history.map((entry) => {
          const key = `${entry.at}-${entry.text}`;
          const row = entryView(entry, feedback?.key === key ? feedback : null);
          return (
            <div
              key={key}
              className={`voice__entry voice__entry--${entry.tone}${
                row.variant ? ` voice__entry--${row.variant}` : ""
              }`}
              role="button"
              tabIndex={0}
              title={row.title}
              onClick={(event) => {
                // Bail only for a selection inside THIS row (a drag-select in
                // progress); a selection elsewhere is unrelated and must not
                // block the copy.
                const selection = window.getSelection();
                if (
                  selection &&
                  selection.toString() &&
                  selection.containsNode(event.currentTarget, true)
                ) {
                  return;
                }
                copyEntry(entry.text, key);
              }}
              onKeyDown={(event) => {
                if (event.repeat) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  copyEntry(entry.text, key);
                }
              }}
            >
              <span className="voice__tone">{row.glyph}</span>
              <span className="voice__text">{row.text}</span>
            </div>
          );
        })}
      </div>

    </div>
  );
}

/** A model download is running somewhere — surface it in the dock, since the
 * transfer started in settings outlives that dialog. Cancel lives here too,
 * so the tab is a real download surface, not just an indicator. */
function DownloadStrip({
  active,
}: {
  active: Readonly<Record<string, DownloadState>>;
}) {
  const { downloads } = runtime();
  const rows = downloadRows(active);
  if (rows.length === 0) return null;
  return (
    <div className="voice__downloads">
      {rows.map((row) => (
        <div key={row.id} className="voice__download">
          <span className="voice__download-name">{row.text}</span>
          <Button
            size="sm"
            className="voice__model-btn"
            onClick={() => downloads.cancel(row.id)}
            title={MODELS_TEXT.cancelTitle}
          >
            ✕
          </Button>
          <span className="voice-models__bar">
            <span className="voice-models__bar-fill" style={row.fill} />
          </span>
        </div>
      ))}
    </div>
  );
}
