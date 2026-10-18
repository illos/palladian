import { passkey } from "@better-auth/passkey";
import { APIError } from "better-auth/api";

/**
 * Passkeys replace the password at sign-in, so each one must be discoverable
 * (sign in without typing an email) and unlocked by Face ID, Touch ID or the
 * device passcode. Better Auth accepts mere presence by default.
 */
export function passkeys(siteUrl: string) {
  const site = new URL(siteUrl);
  return passkey({
    rpID: site.hostname,
    rpName: "Palladian",
    origin: site.origin,
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    registration: {
      afterVerification: ({ verification }) => {
        if (!verification.registrationInfo?.userVerified) throw unverified();
        return undefined;
      },
    },
    authentication: {
      afterVerification: ({ verification }) => {
        if (!verification.authenticationInfo.userVerified) throw unverified();
      },
    },
  });
}

function unverified() {
  return new APIError("UNAUTHORIZED", {
    message:
      "Unlock the passkey with Face ID, Touch ID or your device passcode.",
  });
}

/** Table metadata for the component adapter; no deployment settings needed. */
export const schemaOptions = {
  plugins: [passkeys("https://palladian.invalid")],
};
