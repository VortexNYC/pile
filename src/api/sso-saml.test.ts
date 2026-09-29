import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import * as samlify from "samlify";
import { describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { member, ssoProvider, user } from "../global/schema.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";

const origin = (
  env.ALLOWED_ORIGINS ??
  env.BETTER_AUTH_URL ??
  "https://pile.example.workers.dev"
)
  .toString()
  .split(",")[0]
  .trim();

// Throwaway mock-IdP keypair (generated for tests only, never a real secret).
const IDP_CERT = `-----BEGIN CERTIFICATE-----
MIIDGzCCAgOgAwIBAgIUVDlK794DiHLy7W63WIfSJ6C+/u0wDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSbW9jay1pZHAucGlsZS50ZXN0MB4XDTI2MDkyNTE3MzMy
MVoXDTM2MDkyMjE3MzMyMVowHTEbMBkGA1UEAwwSbW9jay1pZHAucGlsZS50ZXN0
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu04DeOkqEbuf+f1Bv4QE
r82/i22w4mJbbG4IWqt+3OqlpnlAzM5HcSvvuVLdbEmIHtF1DV6EV93VgNGhBLZX
C23nPPthGe2aUdE3ma9Szbw1FTt1vtsXCKcBI93S2Kk8fk4LZU82grDuZy2Mnk4U
1N6Me3FC13Wr68UdTG/OKontZWOVoUxTcw+UCXxfJqt0gWzr3ZsBdH/e3dNaUccB
HLIYlKv2XB4lPrb8BsLm3fxsCGbQotWYTuaxx64N3EutIJEWoynAHaugoMPeKEys
8dqQaJcYIrfDg8JgDjXvh7/en2LO++WiUBg8zB/nQacpnAzygOeG8JHGkC1sFSf5
UwIDAQABo1MwUTAdBgNVHQ4EFgQU+STsQaPqsLj3wXuHZuP1UxsLdqowHwYDVR0j
BBgwFoAU+STsQaPqsLj3wXuHZuP1UxsLdqowDwYDVR0TAQH/BAUwAwEB/zANBgkq
hkiG9w0BAQsFAAOCAQEAsKfgyw/jRM/65k+U89uzpJvKqLKGZCTqdPvYtWNvcgcj
2+nD0PnQ2OWTCUUI9b8TXNiKj1bD2bngb6ErXmFLmMpX4Pflmsk1pGzTVBWV8hRB
bFYt+9xQjlJnTL34iGOdFBRJx9vGIEyYzf04jefIHoKIkYtpt2QcRhhyynxgPBcP
2sTYRiOeXBRu0gK/DxNDC3+VMXbfq/wACAdsbrmvUh/sajqtuNOBUjLeo+u3xgCJ
cXH02SIbjG/7rwiSWAcPR1OIoBUpTj5SlTDaBoFSdRgkBc7xxE9Lyyz9LCcFjUFu
Z5QdXytfM/qRtih2N67xXfOXyN2gu3wII231aH+s8A==
-----END CERTIFICATE-----`;
const IDP_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7TgN46SoRu5/5
/UG/hASvzb+LbbDiYltsbghaq37c6qWmeUDMzkdxK++5Ut1sSYge0XUNXoRX3dWA
0aEEtlcLbec8+2EZ7ZpR0TeZr1LNvDUVO3W+2xcIpwEj3dLYqTx+TgtlTzaCsO5n
LYyeThTU3ox7cULXdavrxR1Mb84qie1lY5WhTFNzD5QJfF8mq3SBbOvdmwF0f97d
01pRxwEcshiUq/ZcHiU+tvwGwubd/GwIZtCi1ZhO5rHHrg3cS60gkRajKcAdq6Cg
w94oTKzx2pBolxgit8ODwmAONe+Hv96fYs775aJQGDzMH+dBpymcDPKA54bwkcaQ
LWwVJ/lTAgMBAAECggEAU3vNo2Y1eIrqnneJhw2WMy+e6Mve08BoJFeUxKj8lgXG
CIGx5rcoc6JUKoNrKrlJgQb1x5wxm6JF57FHtfx5pp/5OZ6HpJFZP49jW04gN4/k
Dw8eB4/KX/Jj2TMlJ6miy18IyEJ6ttyangVY0DRYJ5r7/Yc5diQ+GQuV5/xLZXyq
PpUo3pBWxPYCz0hhuSWSoCl0XEdpJjr1nUP8Tu7NpUbc2Ecni8Do+6htUvGe7Uaw
jNCn9zJNRy/FGAqROO1MN17l7oBKM0EwjqZ/qE0MptDz3Jv8HQ8+uFxAqXF9cn5t
H2/0lIJu8mUXm/OglC0VVJ3g5YHHwYJ7vhza22ajfQKBgQDgeNwDpYk0cUHp5XPN
HlqvrnH8JXR14gbDN2auuY8610PBRP6TSERtxCwjyAlsI3dbCOT8UklGW46tgNoh
d+DrhqdEMeYLV8JFlWI4TaDP5xHa/CvfYxW6KNKznkCCPipHzue5kf7ldQ5hZ7WQ
o3yTE+B0IiRVgzDp3xv4hRSVlwKBgQDVnMK/1+Xv/XZ3EO5D7F+U+sSYXwTCvpgm
v2jiNCDBVz1FQHjIZyuAAauioM+2+RkQq1zJNSUtWjFnkdrSnhIUxRRNgKyJ/Kt4
cvC/aETeoktuNzfu1lQYmWbUDrrYWAhoxif5iSmLvUwxBA/ssH6qRWG503HHIYGu
UhZ4FBDJpQKBgD7inQCIh3+hmw2jsmVsc4t0G4rAE3hS8gIOqz2XzoB1fg3O/mLU
hBccNiFwEPOym+VtAHmPs+d6Duacin+FzgUtm/6G3COhWlOUHggX901HNsFalA/o
+lVEyoJ3eysBr2aemFxsgjRWLskq/Lqgkm3By8e9KOCr+DAMyRE+dx3RAoGBAIKc
f1feIvJDAJR8/bL6bNcjHeIs9zQ8ZbwLfY4SYZTWSth1O2UN8EMswk2GFnvCg9j1
bp54qGq6o0q4nBv8GwIoHunkq5sTq6TSYvImRzX59jVF/iVDV9hSs9UlzIlMCphF
0Vt6yrRu4o919Ga85DYohkChUQh5LFnyR1rUqg8hAoGAK1X7WnaUyO56iSOJP8E6
yu7LXkg7vVQLl+sgNJ9Th8iNJbL+jwjHha0q7PERLKORH1s5ND6cb6S2w1YTdWfM
DRHYVswMLLI9l4g5B9Nn43snJoWWOvHjh59YJk28FjbKPP0REXTlNqt8C1Hu0tsz
knBL1zrwHBmxvDo4MnRGx5o=
-----END PRIVATE KEY-----`;

const IDP_ENTITY_ID = "https://mock-idp.pile.test";
const IDP_SSO_URL = "https://mock-idp.pile.test/sso";

const certBody = IDP_CERT.replace(/-----[^-]+-----|\s/g, "");
const IDP_METADATA = `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${IDP_ENTITY_ID}">
  <IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing">
      <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
        <X509Data><X509Certificate>${certBody}</X509Certificate></X509Data>
      </KeyInfo>
    </KeyDescriptor>
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${IDP_SSO_URL}"/>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${IDP_SSO_URL}"/>
  </IDPSSODescriptor>
</EntityDescriptor>`;

async function adminCookie(): Promise<string> {
  const auth = await createAuth(env);
  const email = `saml-${crypto.randomUUID()}@example.com`;
  const password = "password123";
  await auth.api.signUpEmail({
    body: { email, password, name: "SAML Admin" },
  });
  const res = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.includes("better-auth.session_token="));
  if (!cookie) {
    throw new Error("no session cookie");
  }
  return cookie;
}

describe("SAML SSO handshake", () => {
  it("completes an IdP-initiated login with a real signed response", async () => {
    const cookie = await adminCookie();
    // Onboard a workspace so the admin can register a provider.
    const onboard = await app.fetch(
      new Request(new URL("/workspaces/onboard", origin), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: origin,
        },
        body: JSON.stringify({
          name: "SAML WS",
          slug: `saml-${crypto.randomUUID()}`,
        }),
      }),
      env
    );
    expect(onboard.status).toBe(201);
    const { workspace } = (await onboard.json()) as {
      workspace: { id: string };
    };

    // Register a SAML provider bound to this org.
    const providerId = `mock-idp-${crypto.randomUUID().slice(0, 8)}`;
    const register = await app.fetch(
      new Request(new URL("/api/auth/sso/register", origin), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: origin,
        },
        body: JSON.stringify({
          providerId,
          issuer: origin,
          domain: "example.com",
          organizationId: workspace.id,
          samlConfig: {
            issuer: origin,
            entryPoint: IDP_SSO_URL,
            cert: IDP_CERT,
            idpMetadata: { entityID: IDP_ENTITY_ID, cert: IDP_CERT },
            wantAssertionsSigned: true,
          },
        }),
      }),
      env
    );
    expect(register.status).toBe(200);

    const signInRequest = () =>
      new Request(new URL("/api/auth/sign-in/sso", origin), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId,
          callbackURL: `${origin}/sso-done`,
        }),
      });

    // domainVerification is enabled: sign-in is refused until the provider
    // proves domain ownership.
    const unverified = await app.fetch(signInRequest(), env);
    expect(unverified.status).toBe(401);
    expect(await unverified.json()).toMatchObject({
      message: "Provider domain has not been verified",
    });

    // The DNS TXT lookup can't run in workerd tests; record the outcome a
    // successful /sso/verify-domain would persist.
    const db = createD1(env.D1);
    await db
      .update(ssoProvider)
      .set({ domainVerified: true })
      .where(eq(ssoProvider.providerId, providerId));

    // Fetch our SP metadata and build a mock IdP against it.
    const spMetaRes = await app.fetch(
      new Request(
        new URL(
          `/api/auth/sso/saml2/sp/metadata?providerId=${providerId}`,
          origin
        )
      ),
      env
    );
    expect(spMetaRes.status).toBe(200);
    const spMetadata = await spMetaRes.text();
    expect(spMetadata).toContain("EntityDescriptor");

    const sp = samlify.ServiceProvider({ metadata: spMetadata });
    const idp = samlify.IdentityProvider({
      metadata: IDP_METADATA,
      privateKey: IDP_KEY,
      nameIDFormat: ["urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"],
    });

    // SP-initiated: ask our worker for a login redirect, which carries a
    // deflated SAMLRequest the IdP parses and answers.
    const signIn = await app.fetch(signInRequest(), env);
    expect(signIn.status).toBe(200);
    const { url: redirectUrl } = (await signIn.json()) as { url: string };
    const samlRequest = new URL(redirectUrl).searchParams.get("SAMLRequest");
    expect(samlRequest).toBeTruthy();

    const requestInfo = await idp.parseLoginRequest(sp, "redirect", {
      query: { SAMLRequest: samlRequest },
    });

    const email = `sso-${crypto.randomUUID()}@example.com`;
    const { context: samlResponse } = (await idp.createLoginResponse(
      sp,
      { extract: requestInfo.extract },
      "post",
      { email }
    )) as { context: string };

    // POST the signed response to our ACS endpoint.
    const acs = await app.fetch(
      new Request(new URL(`/api/auth/sso/saml2/sp/acs/${providerId}`, origin), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ SAMLResponse: samlResponse }).toString(),
        redirect: "manual",
      }),
      env
    );
    expect([302, 303]).toContain(acs.status);
    const cookies = acs.headers.getSetCookie();
    expect(cookies.some((c) => c.includes("better-auth.session_token="))).toBe(
      true
    );

    // organizationProvisioning: the SSO user lands as a member of the org.
    const rows = await db
      .select({ role: member.role })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(
        and(eq(member.organizationId, workspace.id), eq(user.email, email))
      );
    expect(rows).toEqual([{ role: "member" }]);
  });
});
