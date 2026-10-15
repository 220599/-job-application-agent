'use client';

import { Badge } from '@/components/ui';
import type { SubmissionStatusView } from '@/lib/api';
import { PHASE_PRESENTATION } from '@/lib/submission-phases';

// Renders the server-derived status only. A missing status falls back to the
// most conservative label - the UI never claims progress the API has not
// confirmed from persisted state.
export function StatusBadge({ status }: { status: SubmissionStatusView | null }) {
  const phase = status?.phase ?? 'PREPARATION_REQUIRED';
  const presentation =
    PHASE_PRESENTATION[phase] ?? PHASE_PRESENTATION.PREPARATION_REQUIRED;
  return <Badge variant={presentation.variant}>{presentation.label}</Badge>;
}
