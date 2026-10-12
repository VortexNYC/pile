import { Button } from "@cloudflare/kumo/components/button";
import { InputArea } from "@cloudflare/kumo/components/input";
import { useMemo, useState } from "react";

import { filterMentionTargets, mentionQuery } from "@/lib/mentions";

export type MentionTarget = {
  id: string;
  name: string;
  email: string;
};

// A "@handle" being typed at the end of the text — the picker matches
// against name (spaces stripped) and the email local part, the same
// handles the API's resolveMentions uses.


export type ComposerMode = {
  id: string;
  /** Toggle button label (e.g. "Reply to customer"). */
  label: string;
  placeholder: string;
  submitLabel: string;
};

/** The one composer — InputArea + submit, with an optional mode toggle
 * (ticket's reply-vs-note). Issues write comments, tickets write
 * replies/notes, sessions take prompts — same affordance everywhere. */
export function Composer({
  modes,
  placeholder = "Write…",
  submitLabel = "Send",
  loading,
  disabled,
  onSubmit,
  members,
  "aria-label": ariaLabel = "Message",
}: {
  modes?: ComposerMode[];
  placeholder?: string;
  submitLabel?: string;
  loading?: boolean;
  disabled?: boolean;
  onSubmit: (text: string, mode: string | undefined) => void;
  "aria-label"?: string;
  /** Workspace members for @mention autocomplete. */
  members?: MentionTarget[];
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState(modes?.[0]?.id);
  const q = mentionQuery(text);
  const suggestions = useMemo(
    () => (q === null || !members?.length ? [] : filterMentionTargets(members, q)),
    [q, members]
  );

  const insertMention = (member: MentionTarget) => {
    const handle = member.name.toLowerCase().replace(/\s+/g, "-");
    setText(text.replace(/@[a-zA-Z0-9._-]{0,}$/, `@${handle} `));
  };
  const active = modes?.find((m) => m.id === mode) ?? modes?.[0];
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = text.trim();
        if (trimmed && !loading && !disabled) {
          onSubmit(trimmed, mode);
          setText("");
        }
      }}
    >
      {modes && modes.length > 1 ? (
        <div className="flex gap-2" role="group" aria-label="Message type">
          {modes.map((m) => (
            <Button
              key={m.id}
              type="button"
              size="sm"
              variant={mode === m.id ? "primary" : "ghost"}
              aria-pressed={mode === m.id}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="relative">
        <InputArea
          aria-label={ariaLabel}
          placeholder={active?.placeholder ?? placeholder}
          value={text}
          autoResize
          minRows={3}
          onValueChange={setText}
          disabled={disabled}
        />
        {suggestions.length > 0 ? (
          <ul
            className="border-kumo-line bg-kumo-base absolute inset-x-0 bottom-full mb-1 flex flex-col gap-0.5 rounded-md border p-1 shadow-md"
            aria-label="Mention suggestions"
          >
            {suggestions.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className="hover:bg-kumo-tint flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left"
                  onClick={() => insertMention(m)}
                >
                  <span className="text-kumo-default text-sm">{m.name}</span>
                  <span className="text-kumo-subtle text-xs">{m.email}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div>
        <Button
          type="submit"
          variant="primary"
          loading={loading}
          disabled={disabled || text.trim().length === 0}
        >
          {active?.submitLabel ?? submitLabel}
        </Button>
      </div>
    </form>
  );
}
