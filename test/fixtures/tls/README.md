# TLS test fixtures — TEST-ONLY

These certificates and private keys exist only for `test/tls-verification.test.js`.
Nothing outside the test suite uses them. They are not trusted anywhere, nothing
real is signed with them, and they never ship: electron-builder packages `src/`,
`assets/`, `node_modules/` and `package.json` only.

Every certificate is valid for 100 years (issued 2026-10-01, expires 2126-09-07),
so the suite does not start failing on an expiry date.

| File | What it is |
|------|------------|
| `ca.crt` | Self-signed test CA, `CN=Quework Desktop TEST-ONLY CA`. Its private key was discarded once the two leaves below were signed, so it cannot sign anything else. |
| `localhost.crt` / `localhost.key` | Leaf for `DNS:localhost`, signed by the test CA. |
| `mismatch.crt` / `mismatch.key` | Leaf for `DNS:not-this-host.test`, signed by the test CA. The suite serves it on `localhost` to prove hostname checking stays on. |

The private keys are committed on purpose: a local HTTPS server in the test has
to present these certificates. GitHub secret scanning may flag them; that is
expected and safe to dismiss for this directory.

## Regenerating

You only need to regenerate if the files are lost. Generate a new CA, sign both
leaves with it, then delete the CA key:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 36500 -keyout ca.key -out ca.crt \
  -subj "/CN=Quework Desktop TEST-ONLY CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
# for each of  localhost -> DNS:localhost  and  mismatch -> DNS:not-this-host.test :
openssl req -newkey rsa:2048 -nodes -sha256 -keyout localhost.key -out localhost.csr -subj "/CN=localhost"
printf "subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n" > localhost.ext
openssl x509 -req -sha256 -days 36500 -in localhost.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out localhost.crt -extfile localhost.ext
rm ca.key ca.srl *.csr *.ext
```
