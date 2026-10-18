/** Passkey support on this device, and the one-time offer after a password sign-in. */

const OFFER_KEY = "palladian.notes.passkey-offer.v1";

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && "PublicKeyCredential" in window;
}

/** Face ID, Touch ID, Windows Hello or a device passcode can unlock a passkey here. */
export async function platformPasskeys(): Promise<boolean> {
  try {
    return (
      passkeysSupported() &&
      (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
    );
  } catch {
    return false;
  }
}

/** The browser can suggest passkeys in the email field's autofill. */
export async function passkeyAutofill(): Promise<boolean> {
  try {
    return (
      passkeysSupported() &&
      typeof PublicKeyCredential.isConditionalMediationAvailable ===
        "function" &&
      (await PublicKeyCredential.isConditionalMediationAvailable())
    );
  } catch {
    return false;
  }
}

/** A label for a new passkey; the person can tell their devices apart. */
export function deviceName(): string {
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) return "iPhone";
  if (/iPad/.test(agent)) return "iPad";
  if (/Android/.test(agent)) return "Android";
  if (/Macintosh/.test(agent))
    return navigator.maxTouchPoints > 1 ? "iPad" : "Mac";
  if (/Windows/.test(agent)) return "Windows";
  return "This device";
}

/** The unlock method people recognise on this device, when there is one. */
export function unlockName(): string | null {
  const device = deviceName();
  if (device === "iPhone" || device === "iPad") return "Face ID";
  if (device === "Mac") return "Touch ID";
  if (device === "Windows") return "Windows Hello";
  return null;
}

/** Ask once per device, after a password sign-in, whether to add a passkey. */
export const passkeyOffer = {
  pending(): boolean {
    try {
      return localStorage.getItem(OFFER_KEY) === "pending";
    } catch {
      return false;
    }
  },
  ask(): void {
    try {
      if (localStorage.getItem(OFFER_KEY) !== "settled")
        localStorage.setItem(OFFER_KEY, "pending");
    } catch {
      // Private browsing without storage: no offer.
    }
  },
  settle(): void {
    try {
      localStorage.setItem(OFFER_KEY, "settled");
    } catch {
      // Nothing to remember.
    }
  },
};
