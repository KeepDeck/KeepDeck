import { useEffect, useRef } from "react";
import { MCP_SERVER_NAME_RULE } from "../../domain/mcp";
import { EditorFrame } from "../library/EditorFrame";
import type { McpForm } from "./mcpForm";

/** What the dialog decided about the current form — the editor renders
 * verdicts, it never re-derives them. */
export interface McpValidation {
  nameProblem: "empty" | "invalid" | null;
  nameTaken: boolean;
  bodyProblem: "empty-command" | "empty-url" | null;
  /** The first environment or header line that is not a pair. */
  badLine: string | null;
  vanished: boolean;
}

interface McpEditorProps {
  creating: boolean;
  savedName: string | null;
  scopeLabel: string;
  /** The bundled tier uses this same panel without exposing any write control. */
  readOnly?: boolean;
  readOnlyNotice?: string;
  readOnlyHint?: string;
  /** The stored file could not be read: what is typed here replaces it. */
  repairing: string | null;
  form: McpForm;
  dirty: boolean;
  validation: McpValidation;
  canSave: boolean;
  busy: boolean;
  error: string | null;
  onField(key: keyof McpForm, value: string): void;
  onSubmit(): void;
  onDelete(): void;
}

const TRANSPORTS: { value: McpForm["transport"]; label: string }[] = [
  { value: "stdio", label: "Local process" },
  { value: "http", label: "Remote endpoint" },
];

/** The server editor's fields inside the shared frame — a CONTROLLED form:
 * the dialog's state machine owns every decision; this only renders it. */
export function McpEditor({
  creating,
  savedName,
  scopeLabel,
  readOnly = false,
  readOnlyNotice,
  readOnlyHint,
  repairing,
  form,
  dirty,
  validation,
  canSave,
  busy,
  error,
  onField,
  onSubmit,
  onDelete,
}: McpEditorProps) {
  const nameField = useRef<HTMLInputElement>(null);
  // Focus on ENTERING create mode, not at mount: the panel is not remounted
  // per selection, so mount is not when the create form appears.
  useEffect(() => {
    if (creating) nameField.current?.focus();
  }, [creating]);

  const field = (key: keyof McpForm) => (e: { target: { value: string } }) => {
    if (!readOnly) onField(key, e.target.value);
  };

  return (
    <EditorFrame
      creating={creating}
      newTitle="New server"
      savedName={savedName}
      scopeLabel={scopeLabel}
      readOnly={readOnly}
      readOnlyNotice={readOnlyNotice}
      dirty={dirty}
      vanishedMessage={
        validation.vanished
          ? "This server was removed or renamed elsewhere. Copy anything you want to keep — saving it here would recreate a server someone deleted."
          : null
      }
      error={error}
      canSave={canSave}
      busy={busy}
      onSubmit={onSubmit}
      onDelete={onDelete}
    >
      {repairing && (
        <div className="library__hint" role="status">
          This server's file could not be read — {repairing}. What you save here replaces it.
        </div>
      )}
      <div className="library__meta">
        <label className="form__label" htmlFor="mcp-name">
          Name
        </label>
        <input
          id="mcp-name"
          className="form__input"
          ref={nameField}
          value={form.name}
          onChange={field("name")}
          readOnly={readOnly}
          aria-readonly={readOnly}
          placeholder="server-name"
          spellCheck={false}
        />
        {validation.nameProblem === "empty" && (
          <div className="form__error">A server needs a name</div>
        )}
        {validation.nameProblem === "invalid" && (
          <div className="form__error">{`Use ${MCP_SERVER_NAME_RULE}`}</div>
        )}
        {validation.nameTaken && (
          <div className="form__error">A server with this name already exists in this scope</div>
        )}

        <span className="form__label">Transport</span>
        <div className="form__types" role="radiogroup" aria-label="Transport">
          {TRANSPORTS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={form.transport === value}
              className={`form__type${form.transport === value ? " form__type--active" : ""}`}
              onClick={() => {
                if (!readOnly) onField("transport", value);
              }}
              disabled={readOnly}
            >
              {label}
            </button>
          ))}
        </div>

        {form.transport === "stdio" ? (
          <>
            <label className="form__label" htmlFor="mcp-command">
              Command
            </label>
            <input
              id="mcp-command"
              className="form__input"
              value={form.command}
              onChange={field("command")}
              readOnly={readOnly}
              aria-readonly={readOnly}
              placeholder="npx"
              spellCheck={false}
            />
            {validation.bodyProblem === "empty-command" && (
              <div className="form__error">A local server needs a command to run</div>
            )}
            <label className="form__label" htmlFor="mcp-args">
              Arguments · one per line
            </label>
            <textarea
              id="mcp-args"
              className="form__input library__lines"
              value={form.args}
              onChange={field("args")}
              readOnly={readOnly}
              aria-readonly={readOnly}
              placeholder={"-y\n@scope/server"}
              spellCheck={false}
            />
            {readOnlyHint && <p className="library__readonly-hint">{readOnlyHint}</p>}
            {!readOnly && (
              <>
                <label className="form__label" htmlFor="mcp-env">
                  Environment · NAME=value per line
                </label>
                <textarea
                  id="mcp-env"
                  className="form__input library__lines"
                  value={form.env}
                  onChange={field("env")}
                  placeholder="API_TOKEN=…"
                  spellCheck={false}
                />
                <div className="library__hint">
                  Stored privately and handed to the server through its environment — never
                  written into an agent's config.
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <label className="form__label" htmlFor="mcp-url">
              URL
            </label>
            <input
              id="mcp-url"
              className="form__input"
              value={form.url}
              onChange={field("url")}
              readOnly={readOnly}
              aria-readonly={readOnly}
              placeholder="https://…/mcp/"
              spellCheck={false}
            />
            {validation.bodyProblem === "empty-url" && (
              <div className="form__error">A remote server needs a URL</div>
            )}
            <label className="form__label" htmlFor="mcp-headers">
              Headers · Name: value per line
            </label>
            <textarea
              id="mcp-headers"
              className="form__input library__lines"
              value={form.headers}
              onChange={field("headers")}
              readOnly={readOnly}
              aria-readonly={readOnly}
              placeholder="X-Org: …"
              spellCheck={false}
            />
            <label className="form__label" htmlFor="mcp-token">
              Bearer token
            </label>
            <input
              id="mcp-token"
              className="form__input"
              type="password"
              value={form.bearerToken}
              onChange={field("bearerToken")}
              readOnly={readOnly}
              aria-readonly={readOnly}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="library__hint">
              Sent as an Authorization header. Stored privately and referenced through the
              agent's environment — never written into a config.
            </div>
          </>
        )}
        {validation.badLine !== null && (
          <div className="form__error">
            {`This line is not a pair: ${validation.badLine}`}
          </div>
        )}
      </div>
    </EditorFrame>
  );
}
