import type { CapabilityEntry, CapabilityReport } from "../shared/types";

function entry(available: boolean, detail: string): CapabilityEntry {
  return { available, detail };
}

function hasConstructor(name: string): boolean {
  return typeof (globalThis as Record<string, unknown>)[name] !== "undefined";
}

function constructorPrototypeHas(constructorName: string, member: string): boolean {
  const constructor = (globalThis as Record<string, unknown>)[constructorName];
  if (typeof constructor !== "function") return false;
  const prototype = (constructor as { prototype?: object }).prototype;
  return Boolean(prototype && member in prototype);
}

export async function probeCapabilities(): Promise<CapabilityReport> {
  const navigatorWithXR = navigator as Navigator & { xr?: XRSystem };
  const xr = navigatorWithXR.xr;
  const webxr = Boolean(xr && typeof xr.isSessionSupported === "function");

  let immersiveAR = entry(false, "WebXR is unavailable");
  if (webxr && xr) {
    try {
      immersiveAR = entry(
        await xr.isSessionSupported("immersive-ar"),
        "navigator.xr.isSessionSupported(immersive-ar)",
      );
    } catch (error) {
      immersiveAR = entry(false, error instanceof Error ? error.message : "Support probe failed");
    }
  }

  const mediaDevices = navigator.mediaDevices;
  const cameraAccess = Boolean(mediaDevices && typeof mediaDevices.getUserMedia === "function");
  const webglBinding = hasConstructor("XRWebGLBinding");
  const rawXRCamera = constructorPrototypeHas("XRWebGLBinding", "getCameraImage");
  const depth =
    (webglBinding && constructorPrototypeHas("XRWebGLBinding", "getDepthInformation")) ||
    constructorPrototypeHas("XRFrame", "getDepthInformation") ||
    hasConstructor("XRCPUDepthInformation");

  const deviceMotion = hasConstructor("DeviceMotionEvent");
  const deviceOrientation = hasConstructor("DeviceOrientationEvent");
  const webgpu = "gpu" in navigator;
  const opfs =
    "storage" in navigator && typeof navigator.storage?.getDirectory === "function";

  return {
    webxr: entry(webxr, webxr ? "navigator.xr is present" : "navigator.xr is not exposed"),
    immersiveAR,
    cameraAccess: entry(
      cameraAccess,
      cameraAccess ? "getUserMedia is present; permission is requested on demand" : "getUserMedia is unavailable",
    ),
    rawXRCamera: entry(
      rawXRCamera,
      rawXRCamera ? "XRWebGLBinding.getCameraImage is exposed" : "camera-access/WebGL binding is unavailable",
    ),
    depth: entry(
      depth,
      depth ? "WebXR depth API is exposed; session support is device-dependent" : "WebXR depth API is unavailable",
    ),
    gyro: entry(
      deviceMotion,
      deviceMotion ? "DeviceMotionEvent is exposed" : "DeviceMotionEvent is unavailable",
    ),
    accelerometer: entry(
      deviceMotion,
      deviceMotion ? "DeviceMotionEvent acceleration is exposed" : "DeviceMotionEvent is unavailable",
    ),
    webgpu: entry(webgpu, webgpu ? "navigator.gpu is present" : "navigator.gpu is unavailable"),
    opfs: entry(opfs, opfs ? "navigator.storage.getDirectory is present" : "OPFS is unavailable"),
  };
}
