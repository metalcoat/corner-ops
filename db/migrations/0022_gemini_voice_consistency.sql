-- Roll back the affected Gemini preview for the test ordering line.
-- Live connection + Kore configuration are validated before adopting this model.
ALTER TABLE ordering_ai_phone_settings ALTER COLUMN gemini_model SET DEFAULT 'gemini-2.5-flash-native-audio-latest';
UPDATE ordering_ai_phone_settings SET gemini_model='gemini-2.5-flash-native-audio-latest',
  model=CASE WHEN provider='gemini' THEN 'gemini-2.5-flash-native-audio-latest' ELSE model END,
  updated_by='system:voice-consistency',updated_at=NOW()
WHERE business='Corner Deli' AND gemini_model='gemini-3.1-flash-live-preview';
