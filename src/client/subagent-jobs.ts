/**
 * Pure derivations for the Subagent page's background-job section. Kept
 * framework-free so the node test environment can unit-test them: the job
 * rows arrive through the harness `session/jobs` push mirror
 * (`jobsBySession` in the sessions list feed) — nothing here issues
 * requests, and the row ordering / status mapping mirror the official
 * ui-jobs header list.
 */
import type {
  SidebarSessionList,
  SidebarSessionSummary,
  SidebarJobStatus,
  SidebarJobView,
} from '../context-types.ts'
import type { CopyKey } from './locales.ts'

/** One row of the jobs section: the job plus its owning session's title. */
export interface TreeJob {
  ownerSessionId: string
  ownerTitle: string
  job: SidebarJobView
}

/** Whether the registry still holds the job open (its duration ticks). */
export function isJobLive(job: SidebarJobView): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

/**
 * Every session id of the topology tree rooted at `rootId` (the root plus
 * each session whose uninterrupted subagent-origin chain reaches it — same
 * lineage semantics as {@link countSubagentDescendants}; cycles fail soft).
 * Sessions outside the tree (orphans, other trees) are excluded, so the
 * jobs section never shows foreign work.
 */
export function treeSessionIds(
  byId: SidebarSessionList['byId'],
  rootId: string | undefined,
): Set<string> {
  const ids = new Set<string>()
  if (rootId === undefined) return ids
  for (const summary of Object.values(byId)) {
    const seen = new Set<string>()
    let current: SidebarSessionSummary | undefined = summary
    let reachesRoot = false
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id)
      if (current.id === rootId) {
        reachesRoot = true
        break
      }
      if (current.origin !== 'subagent' || current.parentId === undefined) break
      current = byId[current.parentId]
    }
    if (reachesRoot) ids.add(summary.id)
  }
  return ids
}

/**
 * Whether a NEW background job appeared for one session between two
 * consecutive list snapshots (a job id the previous snapshot lacked).
 * @deprecated The Jobs auto-open now gates on {@link detectFirstJob} (0 → N)
 * so a running agent never steals focus mid-work; this stays for the list
 * badge and tests that track individual new job ids.
 */
export function detectNewJob(
  prev: SidebarSessionList,
  next: SidebarSessionList,
  sessionId: string,
): boolean {
  const prevIds = new Set((prev.jobsBySession?.[sessionId] ?? []).map(job => job.id))
  return (next.jobsBySession?.[sessionId] ?? []).some(job => !prevIds.has(job.id))
}

/**
 * Whether the CURRENT conversation crossed from "no background jobs" to
 * "at least one" between two consecutive list snapshots — the 0 → N
 * transition, mirroring the subagent auto-open semantics. The Jobs page
 * auto-surfaces ONCE per session on its first job; every later job the
 * agent starts while the user is reading files or looking at another pane
 * must NOT steal focus (the row still appears in the list and the badge
 * still counts it — only the forced navigation is suppressed). A fresh page
 * load never triggers: its baseline is the current snapshot.
 */
export function detectFirstJob(
  prev: SidebarSessionList,
  next: SidebarSessionList,
  sessionId: string,
): boolean {
  const prevCount = (prev.jobsBySession?.[sessionId] ?? []).length
  if (prevCount > 0) return false
  return (next.jobsBySession?.[sessionId] ?? []).length > 0
}

/**
 * Collect the background jobs of the whole current tree, owner-labeled.
 * Sessions without a mirror entry contribute nothing; an absent mirror
 * (runtime older than the jobs feed) yields an empty list.
 */
export function collectTreeJobs(
  byId: SidebarSessionList['byId'],
  jobsBySession: Readonly<Record<string, readonly SidebarJobView[]>> | undefined,
  rootId: string | undefined,
): TreeJob[] {
  const rows: TreeJob[] = []
  if (jobsBySession === undefined) return rows
  for (const sessionId of treeSessionIds(byId, rootId)) {
    const jobs = jobsBySession[sessionId]
    if (jobs === undefined || jobs.length === 0) continue
    const ownerTitle = byId[sessionId]?.displayTitle ?? sessionId
    for (const job of jobs) rows.push({ ownerSessionId: sessionId, ownerTitle, job })
  }
  return rows
}

/**
 * Collect the background jobs of ONE focused session only — the row list the
 * Jobs section shows when the user has selected a specific agent (the main
 * session or a single subagent). Selecting a node must scope the list to that
 * node's OWN jobs: picking the main session shows the main session's jobs and
 * never its children's, and picking a subagent shows only that child's. An
 * absent mirror or a session with no jobs yields an empty list.
 */
export function collectJobsForFocus(
  byId: SidebarSessionList['byId'],
  jobsBySession: Readonly<Record<string, readonly SidebarJobView[]>> | undefined,
  focusId: string | undefined,
): TreeJob[] {
  const rows: TreeJob[] = []
  if (jobsBySession === undefined || focusId === undefined) return rows
  const jobs = jobsBySession[focusId]
  if (jobs === undefined || jobs.length === 0) return rows
  const ownerTitle = byId[focusId]?.displayTitle ?? focusId
  for (const job of jobs) rows.push({ ownerSessionId: focusId, ownerTitle, job })
  return rows
}

/**
 * Live rows first in start order, then settled rows newest-first (mirror of
 * the official ui-jobs ordering); a tie falls back to start order so the
 * sort never depends on the host's map iteration.
 */
export function orderJobs(rows: readonly TreeJob[]): TreeJob[] {
  return [...rows].sort((left, right) => {
    const liveLeft = isJobLive(left.job)
    if (liveLeft !== isJobLive(right.job)) return liveLeft ? -1 : 1
    if (liveLeft) return left.job.startedAt - right.job.startedAt
    const finished = (right.job.finishedAt ?? right.job.startedAt) - (left.job.finishedAt ?? left.job.startedAt)
    return finished !== 0 ? finished : left.job.startedAt - right.job.startedAt
  })
}

/** The sidebar's StateDot states for the five wire statuses. */
export type JobDotState = 'ongoing' | 'warning' | 'done' | 'error'

/**
 * Status marker semantics. `stopping` and `killed` share the attention
 * color: both mean the work ended (or is ending) on request rather than on
 * its own.
 */
export function jobDotState(status: SidebarJobStatus): JobDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'stopping': return 'warning'
    case 'completed': return 'done'
    case 'killed': return 'warning'
    case 'failed': return 'error'
  }
}

/** Human status word of one wire status (localized through the passed translator). */
export function jobStatusLabel(
  status: SidebarJobStatus,
  t: (key: CopyKey, params?: Record<string, string | number>) => string,
): string {
  switch (status) {
    case 'running': return t('jobStatusRunning')
    case 'stopping': return t('jobStatusStopping')
    case 'completed': return t('jobStatusCompleted')
    case 'killed': return t('jobStatusKilled')
    case 'failed': return t('jobStatusFailed')
  }
}

/**
 * Elapsed time in at most two adjacent units (mirror of the official
 * ui-jobs duration wording). A background job that outlives an hour is
 * already exceptional, so hours is the widest unit.
 */
export function formatJobDuration(
  elapsedMs: number,
  t: (key: CopyKey, params?: Record<string, string | number>) => string,
): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1_000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3_600)
  if (hours > 0) return t('jobDurationHours', { hours, minutes })
  if (minutes > 0) return t('jobDurationMinutes', { minutes, seconds })
  return t('jobDurationSeconds', { seconds })
}

