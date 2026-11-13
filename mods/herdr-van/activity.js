const JOBS_LABEL = "herdr.background-jobs";
const JOB_LEASE_MS = 30_000;

// Terminal labels outlive reporters, so expired snapshots must not look like live work.
export function backgroundJobs(terminal, now) {
  if (terminal.state !== "live" || !["pi", "claude-code"].includes(terminal.report?.app)) return [];
  const value = terminal.labels?.[JOBS_LABEL];
  if (typeof value !== "string") return [];
  let snapshot;
  try {
    snapshot = JSON.parse(value);
  } catch {
    return [];
  }
  if (!snapshot || snapshot.version !== 1 || typeof snapshot.session !== "string" || !snapshot.session
    || !Number.isFinite(snapshot.updatedAt) || snapshot.updatedAt > now
    || now - snapshot.updatedAt >= JOB_LEASE_MS || !Array.isArray(snapshot.jobs)) return [];
  const ids = new Set();
  for (const job of snapshot.jobs) {
    if (!job || typeof job.id !== "string" || !job.id || ids.has(job.id)
      || typeof job.command !== "string" || !Number.isFinite(job.startedAt)
      || job.startedAt < 0 || job.startedAt > snapshot.updatedAt) return [];
    ids.add(job.id);
  }
  return snapshot.jobs;
}

// Jobs and child terminals share one tree, including jobs owned by a nested child.
export function agentChildren(kidsOf, jobsOf, address, lead = []) {
  const children = [
    ...(jobsOf.get(address) ?? []).map(job => ({ job, owner: address })),
    ...(kidsOf.get(address) ?? []).map(t => ({ t })),
  ];
  return children.flatMap((child, i) => {
    const last = i === children.length - 1;
    return [
      { ...child, lines: [...lead, last ? "└" : "├"] },
      ...(child.t ? agentChildren(kidsOf, jobsOf, child.t.address, [...lead, last ? "" : "│"]) : []),
    ];
  });
}
