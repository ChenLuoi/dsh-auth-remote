# Test TLS certificate

`auth-remote.test.cert.pem` and `auth-remote.test.key.pem` are a self-signed certificate and private key for the isolated browser proxy test only. The key is public test material. Do not use it for a service or include this directory in the installation package.

`native.test.cert.pem` and `native.test.key.pem` exercise the official native HTTPS listener. Their SANs cover `localhost`, `auth-remote.test`, `127.0.0.1`, `127.0.0.2`, `::1`, and IPv4-mapped `::ffff:127.0.0.1`. `native.mismatch.key.pem` is an unrelated public test key for the certificate/key mismatch failure. All keys in this directory are deliberately public, disposable fixtures; the npm archive excludes `tests/`.

Node test clients trust only the native fixture certificate with certificate and hostname verification enabled. Native browser tests pin its public-key SPKI hash through Chromium's test option. Production certificate validation is unchanged.

To regenerate the native fixtures from the repository root:

```sh
rtk proxy openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -subj '/CN=DSH Native Transport Test Only' \
  -addext 'subjectAltName=DNS:localhost,DNS:auth-remote.test,IP:127.0.0.1,IP:127.0.0.2,IP:::1,IP:::ffff:127.0.0.1' \
  -keyout tests/fixtures/tls/native.test.key.pem \
  -out tests/fixtures/tls/native.test.cert.pem
rtk proxy openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out tests/fixtures/tls/native.mismatch.key.pem
```

Rerun the native transport integration and browser suites after regeneration. Their certificate pin is computed from the fixture, and no genuine account, session, or service key belongs here.
