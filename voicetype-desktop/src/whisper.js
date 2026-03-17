// ═══════════════════════════════════════
//  VoiceType — OpenAI Whisper Transcription
// ═══════════════════════════════════════
//
// Sends a WAV audio buffer to OpenAI's Whisper API
// and returns the transcribed text.

const OpenAI = require('openai');
const { Readable } = require('stream');
const path = require('path');

/**
 * Transcribe a WAV audio buffer using OpenAI Whisper.
 *
 * @param {string} apiKey - OpenAI API key
 * @param {Buffer} audioBuffer - WAV file as a Buffer
 * @param {string} language - ISO 639-1 language code (e.g. 'en', 'es')
 * @returns {Promise<string>} - Transcribed text
 */
async function transcribe(apiKey, audioBuffer, language = 'en') {
  const client = new OpenAI({ apiKey });

  // OpenAI SDK expects a File-like object.
  // Create a readable stream from the buffer and attach a name.
  const file = new File([audioBuffer], 'recording.wav', { type: 'audio/wav' });

  const response = await client.audio.transcriptions.create({
    model: 'whisper-1',
    file: file,
    language: language,
    response_format: 'text'
  });

  // response is the raw text string when response_format is 'text'
  return typeof response === 'string' ? response : response.text || '';
}

module.exports = { transcribe };
