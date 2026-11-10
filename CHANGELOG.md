# Changelog

## 0.1.1

- The live tests with Vois Studio 2.6.3 pass for all six engines.
- When this computer does not have the engine or a Fast language (`data.reason: "package_not_installed"` in Vois Studio 2.6.3 and after), the server gives `400 engine_not_installed`. The message keeps the text from vois-cli, which names the engine or the language. Before, the server gave `500 vois_cli_error`.
- `data.reason: "voice_not_found"` (Vois Studio 2.6.3 and after) gives `404 voice_not_found`, as exit code 4 did before.

## 0.1.0

- `POST /v1/audio/speech` in the OpenAI format, with the formats mp3, opus, aac, flac, wav and pcm.
- `GET /v1/models` and `GET /v1/audio/voices`.
- The six Vois Studio engines as models. OpenAI voice names give Vois Studio voices that sound almost the same.
- A token, a Host check and a listener only on this computer.
