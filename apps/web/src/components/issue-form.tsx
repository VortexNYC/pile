import { Button } from "@cloudflare/kumo/components/button";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { useState } from "react";

import {
  ISSUE_STATUS_LABELS,
  ISSUE_STATUSES,
  isIssueStatus,
  isPriority,
  type IssuePriority,
  type IssueStatus,
  PRIORITIES,
  PRIORITY_LABELS,
} from "@/lib/labels";

/** Member-facing issue fields only — repo/branch/PR stay CLI-only. */
export interface IssueFormValues {
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
}

export function IssueForm({
  initial,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  initial: IssueFormValues;
  submitLabel: string;
  pending: boolean;
  onSubmit: (values: IssueFormValues) => void;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState(initial);
  const trimmed = values.title.trim();

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending && trimmed.length > 0) {
          onSubmit({ ...values, title: trimmed });
        }
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
        label="Description"
        value={values.description}
        required={false}
        minRows={5}
        autoResize
        onValueChange={(description) => setValues({ ...values, description })}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label="Status"
          value={values.status}
          onValueChange={(status) => {
            if (isIssueStatus(status)) setValues({ ...values, status });
          }}
          renderValue={(v) => (isIssueStatus(v) ? ISSUE_STATUS_LABELS[v] : "")}
        >
          {ISSUE_STATUSES.map((status) => (
            <Select.Option key={status} value={status}>
              {ISSUE_STATUS_LABELS[status]}
            </Select.Option>
          ))}
        </Select>
        <Select
          label="Priority"
          value={values.priority}
          onValueChange={(priority) => {
            if (isPriority(priority)) setValues({ ...values, priority });
          }}
          renderValue={(v) => (isPriority(v) ? PRIORITY_LABELS[v] : "")}
        >
          {PRIORITIES.map((priority) => (
            <Select.Option key={priority} value={priority}>
              {PRIORITY_LABELS[priority]}
            </Select.Option>
          ))}
        </Select>
      </div>
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          disabled={trimmed.length === 0}
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
