# Contributing to Ternlux

Thanks for helping. Bug reports, connector plugins, docs fixes and features are
all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on
  the approach.
- Security problems: do **not** open a public issue. See [SECURITY.md](SECURITY.md).

## Development setup

See [README.md](README.md#build-from-source). In short:

```bash
npm install
npm run electron-dev
```

`npm run electron-dev` starts the React dev server and opens the app against
your normal Ternlux profile. Use a throwaway profile when testing first-run
flows:

```bash
npx electron . --user-data-dir=/tmp/ternlux-test-profile
```

## Pull requests

- Keep each PR to one change, and describe what it does and how you tested it.
- Run `npx react-scripts build` and make sure it compiles.
- Don't commit credentials, `.env` files, logs, or build output (`build/`,
  `dist/`, `dist-min/`).
- New connectors go in `plugins/connectors/<id>/` and follow the interface in
  `public/pluginManager.js`. Include a `package.json` with
  `"license": "Apache-2.0"`.

## Developer Certificate of Origin

Contributions are accepted under the Apache License 2.0. Sign off every commit
to certify that you wrote the change or have the right to submit it under that
license ([DCO 1.1](https://developercertificate.org/)):

```bash
git commit -s -m "Add ClickHouse connector"
```

This adds a `Signed-off-by: Your Name <you@example.com>` line. PRs with
unsigned commits can't be merged.

## Code of conduct

Be respectful and constructive. Harassment of any kind isn't tolerated.
Maintainers may remove comments or contributors that break this rule.
