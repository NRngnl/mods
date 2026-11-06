// Times in the viewer's local time zone (GitHub sends UTC).
const pad = n => String(n).padStart(2, "0");

// "2026-11-06 14:32" in local time.
export function localTime(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "5m", "3h", "2d" since then (an age, so no "ago"); the list has no room for full dates.
export function ago(iso) {
  const m = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  return m < 60 ? `${Math.floor(m)}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}
