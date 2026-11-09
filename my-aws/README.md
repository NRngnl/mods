# my-aws

A read-only AWS panel: CodePipeline state and CloudWatch Logs, modeled on the `cpv` terminal
viewer. It never writes to AWS: no start, retry or approval.

It runs the `aws` CLI (v2) on the focused machine, so credentials are whatever that CLI
resolves there: shared profiles, SSO, environment variables.

## Profiles and region

The header lists the profiles from `aws configure list-profiles` on that machine. Click one to
switch; everything reloads. The region box overrides the profile's region (Enter to apply);
leave it empty (or anything that is not a region code like `us-east-1`) to use the profile default. Profile, region and tab are remembered.

For SSO profiles, run `aws sso login --profile <name>` on that machine first.

## Pipelines

Lists pipelines; the filter box narrows the list as you type. Click one for its stages and actions with status, source revision, failure
message, a Details link to the build or deploy, and a Console link. ↻ refreshes the open view.

## Logs

Lists log groups, then the 50 most recent streams of a group, the last 300 events of a stream. The filter box narrows groups and streams by name. ↻ refreshes the open view.

## Install

```sh
cp -R my-aws ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/my-aws
```

Add `"mod": "my-aws"` to a panel in your layout, then restart the app.

## Limits

- No automatic refresh or live tail; use ↻.
- Log groups are capped at 1000, streams at 50, events at 300.
- No Logs Insights queries, filter patterns or JSON templates (the `cpv` extras).
