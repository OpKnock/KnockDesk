# Code signing for KnockDesk (Windows)

Unsigned builds trigger SmartScreen ("Windows protected your PC") for anyone
who has not built up reputation. Removing that warning requires an
**Authenticode certificate issued by a trusted root** — the `signtool` and
`Set-AuthenticodeSignature` commands you may find on the web are just the free
*tools*; the trust they confer comes from the certificate behind them.

## Option 1 — SignPath Foundation (free, open source) ✅ recommended

SignPath signs open-source projects **free of charge** with a trusted
certificate. KnockDesk already qualifies:

- Public repository on GitHub (`OpKnock/KnockDesk`) ✅
- OSI-approved license (Apache 2.0) ✅
- Builds run in GitHub Actions ✅

How to apply:
1. Go to <https://signpath.io/opensource> and submit the repository.
2. Approval typically takes a few days; they review that the project is
   genuine open source (no obfuscation, no bundled secrets).
3. Once approved, install their GitHub App and add a signing step to the
   workflow:
   ```yaml
   - name: Sign installer (SignPath)
     uses: signpath/github-action-sign@1
     with:
       api-key: ${{ secrets.SIGNPATH_API_KEY }}
       organization-id: ${{ secrets.SIGNPATH_ORGANIZATION_ID }}
       project-slug: knockdesk
       signing-policy-slug: release-signing
       artifact-configuration-slug: windows-installer
       input-artifact-paths: dist/KnockDesk-Setup-*.exe
   ```
   Their action replaces the local cert flow entirely: SignPath holds the
   certificate, CI uploads the artifact, the signed file comes back. No
   secrets in the repo except the API key.

## Option 2 — Azure Trusted Signing (cheap, ~$9.99/month)

Microsoft's own cloud signing service. The certificate lives in your Azure
account; CI calls it with a detached signature request. Cheapest way to get
**full trust without the OV reputation ramp** (which can take weeks of
downloads before SmartScreen stops warning).

## Option 3 — Buy an OV certificate (~$200–600/year)

DigiCert, Sectigo, SSL.com. Works with the existing local flow below. An OV
certificate still needs to build download reputation before SmartScreen
silences; EV is instant but costs more.

## Option 4 — Free-CA programs for open source

SSL.com and Certum have historically issued free OV code-signing certificates
to open-source projects. Worth applying in parallel with SignPath.

## What is already wired in this repo

- `scripts/sign-release.ps1` — local signing with `signtool`, timestamped
  (RFC3161), verifies the signature afterwards. Refuses to run without a
  certificate rather than self-signing. Env inputs (never commit them):
  - `KNOCKDESK_PFX_PATH` / `KNOCKDESK_PFX_PASSWORD`
  - `KNOCKDESK_TIMESTAMP_URL` (optional, defaults to DigiCert)
- The `Build Windows installer` workflow has a signing step gated on the CI
  secrets `WINDOWS_CERT_PFX_B64` + `WINDOWS_CERT_PASSWORD`; it runs
  automatically the moment both are set in repository settings, and the
  tag-triggered release then publishes the signed installer.

Usage once you have a `.pfx`:
```powershell
$env:KNOCKDESK_PFX_PATH = 'C:\keys\knockdesk.pfx'
$env:KNOCKDESK_PFX_PASSWORD = '***'
powershell -ExecutionPolicy Bypass -File scripts/sign-release.ps1 -ExePath KnockDesk.exe
```

## Testing before a certificate exists

A self-signed signature does **not** remove SmartScreen for other machines
(the root is not trusted), so shipping one is worse than shipping unsigned
with published checksums. For a test machine, the practical options
are unchanged: click **More info → Run anyway**, or add the root certificate
to that machine's Trusted Root store so the file verifies locally. The
published SHA-256 on the release page is the integrity check either way.
