import { Button } from "@cloudflare/kumo/components/button";
import { InputArea } from "@cloudflare/kumo/components/input";
import { useState } from "react";

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
  "aria-label": ariaLabel = "Message",
}: {
  modes?: ComposerMode[];
  placeholder?: string;
  submitLabel?: string;
  loading?: boolean;
  disabled?: boolean;
  onSubmit: (text: string, mode: string | undefined) => void;
  "aria-label"?: string;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState(modes?.[0]?.id);
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
      <InputArea
        aria-label={ariaLabel}
        placeholder={active?.placeholder ?? placeholder}
        value={text}
        autoResize
        minRows={3}
        onValueChange={setText}
        disabled={disabled}
      />
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
