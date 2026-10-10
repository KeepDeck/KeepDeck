import { useSyncExternalStore, type KeyboardEvent } from "react";
import type { CustomSettingsFieldProps } from "@keepdeck/plugin-api";
import { Button } from "@keepdeck/ui-kit/Button";
import { activeModel, MODEL_KEY, readModelPick } from "../modelChoice";
import { modelCards, type ModelCard } from "../modelsView";
import { runtime } from "../runtime";

/**
 * The model manager, rendered inside the plugin's settings page (a `custom`
 * settings field — the declarative vocabulary has no download progress).
 * One card per model as `modelCards` describes it; choosing an installed
 * card (click, Enter or Space) makes it the active model; weights download
 * on demand and never ship with the app.
 */
export function ModelsSection({ values, write }: CustomSettingsFieldProps) {
  const { downloads, models: store } = runtime();
  // Both the list and download progress come from plugin-level stores, so
  // this section, the dock tab, and a download in flight all see one truth.
  const models = useSyncExternalStore(store.subscribe, store.snapshot);
  const listError = useSyncExternalStore(store.subscribe, store.error);
  const removeErrors = useSyncExternalStore(store.subscribe, store.removeErrors);
  const dl = useSyncExternalStore(downloads.subscribe, downloads.snapshot);
  const active = models ? (activeModel(models, readModelPick(values))?.id ?? null) : null;
  const cards = models ? modelCards(models, active, dl, removeErrors) : [];

  const choose = (card: ModelCard) => card.selectable && write(MODEL_KEY, card.id);
  const onKey = (card: ModelCard) => (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    choose(card);
  };
  const discard = (card: ModelCard) => {
    const model = models?.find((m) => m.id === card.id);
    if (!model) return;
    void store.remove(model).then(() => downloads.forget(card.id));
  };
  const runAction = (card: ModelCard) => {
    switch (card.action.kind) {
      case "delete": {
        const model = models?.find((m) => m.id === card.id);
        if (model) void store.remove(model);
        return;
      }
      case "cancel":
        return downloads.cancel(card.id);
      case "download":
        return void downloads.start(card.id);
    }
  };

  return (
    <div className="voice-models" role="radiogroup" aria-label="Speech model">
      <div className="voice-models__warn">
        Extremely experimental — recognition and commands are rough, and this
        may change or break between versions.
      </div>
      {listError && <div className="voice-models__error kd-selectable">{listError}</div>}
      {cards.map((card) => (
        <div
          key={card.id}
          className={`voice-models__card${card.active ? " voice-models__card--active" : ""}`}
          onClick={() => choose(card)}
          onKeyDown={onKey(card)}
          role="radio"
          aria-checked={card.active}
          aria-disabled={!card.selectable}
          tabIndex={card.selectable ? 0 : -1}
        >
          <div className="voice-models__head">
            <span className="voice-models__name">
              {card.name}
              {card.active && <span className="voice-models__badge">✓ Active</span>}
              {card.legacy && (
                <span className="voice-models__badge voice-models__badge--legacy">Legacy</span>
              )}
            </span>
            <Rating label="accuracy" value={card.accuracy} />
          </div>
          <div className="voice-models__row">
            <span className="voice-models__blurb">{card.blurb}</span>
            <Rating label="speed" value={card.speed} />
          </div>
          <div className="voice-models__foot">
            <span>{card.langs}</span>
            <span className="voice-models__foot-right">
              <span>{card.size}</span>
              {/* The card's click picks the model; a press on one of its own
                  actions must not also pick it — the Delete of an installed
                  model least of all. Only the actions are contained: the
                  size beside them still picks. */}
              <span
                className="voice-models__acts"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <CardActionView card={card} run={() => runAction(card)} />
                {card.discardable && (
                  <Button size="sm" onClick={() => discard(card)} title="Delete the partly downloaded file">
                    Discard
                  </Button>
                )}
              </span>
            </span>
          </div>
          {card.bar && (
            <span className="voice-models__bar">
              <span
                className="voice-models__bar-fill"
                style={
                  card.bar.percent === null
                    ? { width: "100%", opacity: 0.4 }
                    : { width: `${card.bar.percent}%` }
                }
              />
            </span>
          )}
          {card.error && <div className="voice-models__card-error kd-selectable">{card.error}</div>}
        </div>
      ))}
    </div>
  );
}

function CardActionView({ card, run }: { card: ModelCard; run: () => void }) {
  switch (card.action.kind) {
    case "delete":
      return (
        <Button size="sm" onClick={run}>
          Delete
        </Button>
      );
    case "cancel":
      return (
        <>
          <span className="voice-models__progress">{card.action.progress}</span>
          <Button size="sm" onClick={run} title="Stop — the next Download resumes from here">
            ✕
          </Button>
        </>
      );
    case "download":
      return (
        <Button size="sm" onClick={run}>
          {card.action.label}
        </Button>
      );
    case "none":
      return null;
  }
}

function Rating({ label, value }: { label: string; value: number }) {
  return (
    <span className="voice-models__rating">
      <span className="voice-models__rating-label">{label}</span>
      <span className="voice-models__rating-track">
        <span className="voice-models__rating-fill" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
    </span>
  );
}
