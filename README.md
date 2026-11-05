# speech-endpoint

Use Vois Studio voices in apps that use the OpenAI speech API. speech-endpoint is a small server on your computer. An app sends text to it, and it gives back audio from Vois Studio.

It operates with apps that let you change the address of the OpenAI speech API, for example open-notebook and VoiceMode.

Vois Studio is closed source. speech-endpoint is open source with the MIT license.

## Before you start

- [Vois Studio](https://vois.so/download?utm_source=github&utm_medium=speech-endpoint&utm_campaign=oss) on an Apple Silicon Mac or on Windows. Vois Studio must be open, or its service must be on (`vois-cli service start`).
- A paid plan of Vois Studio, or export credits. Each request makes an audio file, and audio files from vois-cli are not on the Free plan.
- [Node.js](https://nodejs.org) 18 or a newer version.
- [ffmpeg](https://ffmpeg.org) for the `mp3`, `opus`, `aac` and `flac` formats. For the `wav` and `pcm` formats, ffmpeg is not necessary.

## Start the server

```sh
git clone https://github.com/vois-so/speech-endpoint
cd speech-endpoint
node speech-endpoint.mjs start
```

The server listens on `http://127.0.0.1:8790/v1`. To see the token, open a second terminal and type:

```sh
node speech-endpoint.mjs token
```

In your app, use these values:

| Field in the app | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:8790/v1` |
| API key | The token |
| Model | `tts-1`, or an engine: `sonic`, `fast`, `expressive`, `multilingual`, `omni` or `craft` |
| Voice | An OpenAI voice name, for example `nova`, or a Vois Studio voice ID |

## Connect open-notebook

1. Start speech-endpoint.
2. In open-notebook, add an OpenAI-compatible provider for text to speech.
   - If open-notebook runs in Docker Desktop, the URL is `http://host.docker.internal:8790/v1`.
   - If open-notebook runs on your computer without Docker, the URL is `http://127.0.0.1:8790/v1`.
   - The API key is the token.
3. Add a text-to-speech model for that provider. Use `tts-1` for Sonic, or `omni` for Omni.
4. In a podcast profile, use OpenAI voice names, for example `nova` and `onyx`, or Vois Studio voice IDs.

## Connect VoiceMode

Set these values in the VoiceMode settings or in your environment:

```sh
VOICEMODE_TTS_BASE_URLS=http://127.0.0.1:8790/v1
VOICEMODE_VOICES=nova
VOICEMODE_TTS_MODELS=tts-1
OPENAI_API_KEY=<the token>
```

VoiceMode sends one key, `OPENAI_API_KEY`, to each address in `VOICEMODE_TTS_BASE_URLS`. Thus, you cannot add the OpenAI address to the same list.

## Voices and engines

- The default engine is Sonic. Sonic is fast and has built-in voices.
- An OpenAI voice name (`alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`, `ash`, `ballad`, `coral`, `sage`, `verse`) gives a Sonic voice with Sonic. With a different engine, it gives a library voice that operates with that engine.
- A Vois Studio voice ID gives that voice. To see the voice IDs, type `node speech-endpoint.mjs voices`, or send `GET /v1/audio/voices`.
- `instructions` gives a direction in plain words to Omni and Craft, for example "warm and calm". For the Omni and Craft engines, the Pro plan is necessary.
- `speed` is from 0.5 to 2.0.
- `language` is not in the OpenAI API. Send it to change the language, for example `"language": "German"`. The default is English.

## Settings

The settings file is `~/.config/speech-endpoint/config.json`. On Windows, it is `%APPDATA%\speech-endpoint\config.json`. All fields are optional:

```json
{
  "port": 8790,
  "engine": "sonic",
  "language": "English",
  "voices": { "nova": "sonic_ember" },
  "engineVoices": { "omni": "<voice id>" }
}
```

To see the settings, type `node speech-endpoint.mjs config`.

## Security

- The server listens only on this computer (`127.0.0.1` and `::1`). Other computers cannot connect to it.
- Each request must send the token as `Authorization: Bearer <token>`. To make a new token, type `node speech-endpoint.mjs token --new`.
- The server accepts only these Host names: `localhost`, `127.0.0.1`, `::1` and `host.docker.internal`. This stops attacks from web pages through DNS rebinding.
- The server accepts only JSON bodies of 64 KiB or less, and texts of 4,096 characters or less.
- It does one request at a time.

## Errors

The server gives OpenAI-style errors: `{"error": {"message", "type", "code"}}`.

| HTTP status | Error code | Cause |
| --- | --- | --- |
| 401 | `invalid_api_key` | The token is not correct. |
| 402 | `plan_required` | For audio files, a paid plan or export credits are necessary. |
| 400 | `voice_not_compatible` | The voice does not operate with the engine. |
| 400 | `language_uncertain` | Send a `language`. |
| 404 | `voice_not_found` | Vois Studio does not have the voice. |
| 501 | `ffmpeg_not_found` | Install ffmpeg, or use `wav` or `pcm`. |
| 503 | `app_not_running` | Open Vois Studio, or type `vois-cli service start`. |

## Problems and ideas

Open an [issue](https://github.com/vois-so/speech-endpoint/issues). For a problem in Vois Studio, use [vois-so/vois-studio](https://github.com/vois-so/vois-studio/issues).

## License

MIT. See [LICENSE](LICENSE).
