# my-aws

A read-only AWS panel: CodePipeline state and CloudWatch Logs, modeled on the `cpv` terminal
viewer. It never writes to AWS: no start, retry or approval.

It runs the `aws` CLI (v2) on the focused machine, so credentials are whatever that CLI
resolves there: shared profiles, SSO, environment variables.

## Machine pin

The first header row lists your machines. **follow focus** (default) uses the focused pane's
machine; 📌 a machine to always run `aws` there, whatever is focused. Handy when only one
machine has the AWS config. The pin is remembered.

## Profiles and region

The header lists the profiles from `aws configure list-profiles` on that machine. Click one to
switch; everything reloads. The region box overrides the profile's region (Enter to apply);
leave it empty (or anything that is not a region code like `us-east-1`) to use the profile default. Profile, region and tab are remembered.

For SSO profiles, run `aws sso login --profile <name>` on that machine first.

## Pipelines

Lists pipelines; right-click one (or click its ◇) to pin it to the top (◆), per profile. The filter box narrows the list as you type. Click one for its stages and actions with status, source revision, failure
message, a Details link to the build or deploy, and a Console link.

It updates live like the web console while the pipeline is open: every 3 s with the app focused,
every 30 s when the app is in the background. Leaving the pipeline, the Logs tab or closing the
panel stops it. CodePipeline has no per-request charge, so watching is free on the bill.

## Logs

Lists log groups (the filter box narrows them as you type; right-click one to pin it to the top, ◆, per profile). Opening a group shows the events of
**all its streams** together, oldest first, each with its stream name underneath, like the
console's "Search log group". From there:

- Relative range: 5m, 15m, 1h (default), 3h, 12h, 1d, 1w, or type your own (`30m`, `6h`,
  `2d`; s, m, h, d, w) and press Enter.
- Absolute range: **from** and **to** as `YYYY-MM-DD HH:MM` (seconds optional, or a date alone
  for midnight) in local time; empty **to** means now. Enter in either box applies it, and
  **absolute** switches back to the last one.
- Filter pattern (Enter to apply): CloudWatch's own syntax, run on the AWS side, so it searches
  every event in the range, not only the loaded ones. `ERROR`, `"exact phrase"`, `-DEBUG`,
  `{ $.level = "error" }`.
- **Streams…** lists the 200 most recent streams; pick one to narrow the view to it, and
  **all streams** to go back.

Each event shows local time and (in all-streams view) the stream on a dim line above its message,
so the message uses the full panel width. Click a row to select it, click another to extend the selection to that range, then
**Copy messages**: only the raw messages are copied, without time or stream. Click the only
selected row again (or **Clear**) to deselect.

↻ re-runs the current query.

**Export…** saves **every event matching the current range, pattern and stream**, not just the
loaded 2000: the `aws` CLI pages through all results on the AWS machine. Each line is
`time<TAB>stream<TAB>message`, time in that machine's local zone with its offset. Pick any of your machines, browse folders like my-files
(📁 .. goes up), type a name and **New folder** to create one, edit the file name if you like,
then **Save all matching here**. If the file exists you get **Overwrite** or **Cancel**. Each
machine remembers its last folder, and the last machine is preselected. Another machine gets the
file with `scp -3` over the herdr ssh targets; a notification shows the event count and path.

## Cost

AWS bills these read calls, so the panel never calls AWS on its own:

- The only timer is the pipeline live view (above), and only while a pipeline is open. Logs
  never auto-refresh.
- Switching focus between machines (follow focus) reuses the lists that machine, profile and
  region last loaded; only the first visit fetches.
- A click that repeats the call already running is dropped, so fast double clicks don't double bill.
- The header shows how many AWS calls this panel made since it opened.
- A log view load is one `filter-log-events` paging run (up to 2000 events). **Export** pages
  through every match, so a wide range on a busy group means many requests; narrow the range or
  pattern first. Check current CloudWatch and CodePipeline API pricing for your region.

## Install

```sh
cp -R my-aws ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/my-aws
```

Add `"mod": "my-aws"` to a panel in your layout, then restart the app.

## Limits

- No live tail for logs; use ↻.
- Log groups are capped at 1000, streams at 200, events at 2000 per query (a note says when
  more matched; narrow the range or pattern).
- Export: a message with line breaks spans several lines in the file. A very large export
  runs in the background with no progress bar; the notification comes at the end.
- No live tail, Logs Insights queries or JSON templates.
