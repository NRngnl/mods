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

Lists pipelines; the filter box narrows the list as you type. Click one for its stages and actions with status, source revision, failure
message, a Details link to the build or deploy, and a Console link. ↻ refreshes the open view.

## Logs

Lists log groups (the filter box narrows them as you type). Opening a group shows the events of
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

↻ re-runs the current query.

**Export…** saves **every event matching the current range, pattern and stream**, not just the
loaded 2000: the `aws` CLI pages through all results on the AWS machine. Each line is
`time<TAB>stream<TAB>message` (UTC). Pick any of your machines, browse folders like my-files
(📁 .. goes up), type a name and **New folder** to create one, edit the file name if you like,
then **Save all matching here**. If the file exists you get **Overwrite** or **Cancel**. Each
machine remembers its last folder, and the last machine is preselected. Another machine gets the
file with `scp -3` over the herdr ssh targets; a notification shows the event count and path.

## Install

```sh
cp -R my-aws ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/my-aws
```

Add `"mod": "my-aws"` to a panel in your layout, then restart the app.

## Limits

- No automatic refresh or live tail; use ↻.
- Log groups are capped at 1000, streams at 200, events at 2000 per query (a note says when
  more matched; narrow the range or pattern).
- Export: a message with line breaks spans several lines in the file. A very large export
  runs in the background with no progress bar; the notification comes at the end.
- No live tail, Logs Insights queries or JSON templates.
