import assert from "node:assert/strict";
import test from "node:test";

import { buildHostname, slugifyDnsLabel } from "../src/naming.js";

test("slugifies project, service, and account names", () => {
  assert.equal(slugifyDnsLabel(" AI Native_ATS "), "ai-native-ats");
  assert.equal(
    buildHostname({
      project: "AI Native ATS",
      service: "Frontend",
      account: "KeshavMac",
      domain: "devpublic.test"
    }),
    "ai-native-ats-frontend-keshavmac.devpublic.test"
  );
});

test("keeps the generated DNS label within 63 characters", () => {
  const hostname = buildHostname({
    project: "a-very-long-project-name-that-keeps-going-and-going",
    service: "a-very-long-frontend-service-name",
    account: "a-very-long-developer-account-name",
    domain: "devpublic.test"
  });

  const [label] = hostname.split(".");
  assert.ok(label.length <= 63);
  assert.match(label, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
});

test("rejects empty DNS components", () => {
  assert.throws(() => slugifyDnsLabel("---"), /empty|valid/i);
});
