# AGY plugin root

Antigravity CLI (`agy`) requires a root `plugin.json` with only `name` and
`description`. The portable Agent Plugins manifest at the repository root
cannot satisfy that schema, so this directory is the AGY install root.

```sh
agy plugin install /path/to/bearing-lite/.agy
agy plugin enable bearing-lite
```

`skills/` here is a link to the portable catalog. AGY is a skills-only host:
it has no verified SessionStart/Stop mapping, so hooks stay procedural.
