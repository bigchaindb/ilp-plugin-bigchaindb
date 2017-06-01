# js-ilp-plugin-bigchaindb

> ILP Ledger plugin for BigchainDB

[![npm](https://img.shields.io/npm/v/ilp-plugin-bigchaindb.svg)](https://www.npmjs.com/package/ilp-plugin-bigchaindb)

## Usage

### Node

Use the CommonJS export (also the default package export):
`var BigchainDBLedgerPlugin = require('ilp-plugin-bigchaindb')`

### Browser

Depending on your build system and preferences, you can use any of the following exports:

* CommonJS (default package export; `var BigchainDBLedgerPlugin = require('ilp-plugin-bigchaindb')`)
* ES6 modules (`import BigchainDBLedgerPlugin from 'ilp-plugin-bigchaindb/es6'`)
* Bundled version (UMD export; add `/bundle/bundle.min.js` to your HTML and use
  `window.BigchainDBLedgerPlugin`)

## npm releases

For a new **patch release**, execute on the machine where you're logged into your npm account:

```bash
npm run release
```

Command is powered by [`release-it`](https://github.com/webpro/release-it) package, defined in the `package.json`.

That's what the command does without any user interaction:

- create release commit by updating version in `package.json`
- create tag for that release commit
- push commit & tag
- create a new release on GitHub, with change log auto-generated from commit messages
- publish to npm as a new release

If you want to create a **minor** or **major release**, use these commands:

```bash
npm run release-minor
```

```bash
npm run release-major
```

## License

```
Copyright 2017 BigchainDB GmbH

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```