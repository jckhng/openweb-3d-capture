# Privacy

The official Open Web 3D Capture application processes and stores capture data locally in the browser.

## Capture data

Photos, depth maps, camera poses, motion samples, quality decisions, feature-tracking results, and reconstruction preflight reports are written to Origin Private File System storage on the device. The application has no capture-upload endpoint, cloud synchronization, account system, or analytics integration. Data leaves the device only when the user exports it and independently shares or uploads the resulting files.

Deleting a capture through the application removes its stored capture data from that browser origin. Clearing site storage or uninstalling the browser may also remove captures. Export important data before either action.

## Hosting metadata

The static hosting provider can receive ordinary request metadata needed to serve the application, such as IP address, user agent, requested path, and request time. It does not receive the capture dataset through application code.

## Forks and third-party tools

Forks and alternative deployments can change this behavior. Verify the source and privacy terms of the deployment you use. Exported datasets passed to Spirula Studio, LichtFeld Studio, COLMAP, cloud storage, or other software are governed by those tools and services.

Do not post captures publicly when reporting defects. Follow [SECURITY.md](SECURITY.md) for sensitive reports.
