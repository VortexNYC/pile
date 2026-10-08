import { Button } from "@cloudflare/kumo/components/button";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import { useState } from "react";

export interface DocumentFormValues {
  title: string;
  content: string;
}

export function DocumentForm({
  initial,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  initial: DocumentFormValues;
  submitLabel: string;
  pending: boolean;
  onSubmit: (values: DocumentFormValues) => void;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState(initial);
  const title = values.title.trim();
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending && title) onSubmit({ ...values, title });
      }}
    >
      <Input
        label="Title"
        value={values.title}
        required
        onChange={(event) =>
          setValues({ ...values, title: event.target.value })
        }
      />
      <InputArea
        label="Content"
        description="Markdown is supported."
        value={values.content}
        required={false}
        autoResize
        minRows={12}
        onValueChange={(content) => setValues({ ...values, content })}
      />
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          disabled={!title}
        >
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
