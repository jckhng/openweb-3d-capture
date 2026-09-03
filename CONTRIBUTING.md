# Contributing

Open Web 3D Capture is a local-first capture application. Contributions must preserve these invariants:

- Capture photos, depth, poses, motion data, and diagnostics remain on the device unless the user explicitly exports them.
- Raw WebXR observations remain immutable and distinguishable from derived or refined data.
- WebXR poses are guidance and diagnostic priors; downstream visual SfM remains the production reconstruction authority.
- No analytics, telemetry upload, account system, or network capture endpoint is added without explicit design review and documentation.
- Captures, exports, generated models, virtual environments, and credentials are not committed.

## Development

Use Node.js 18 or newer:

```bash
npm install
npm test
npm run build
```

Keep changes focused. Add or update tests for behavioral changes. Test camera or WebXR changes on a compatible Android device over a secure context; desktop simulation is not sufficient evidence for hardware behavior.

## Capture-data safety

Do not attach capture ZIPs, photos, point clouds, debug crops, or unredacted device reports to public issues or pull requests. These files can disclose faces, homes, location clues, serial numbers, and other private information. Use a private channel agreed with the maintainer when a minimal synthetic reproduction is insufficient.

## Licensing and provenance

By submitting a contribution, you agree that it is licensed under GPL-3.0-or-later. Submit only material you have the right to license. Identify copied or adapted code in the pull request and preserve all required copyright, attribution, and license notices. Do not add dependencies with incompatible terms.
