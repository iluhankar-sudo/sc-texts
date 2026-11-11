import json, torch, soundfile as sf
lines = json.load(open('tts/lines.json', encoding='utf-8'))
model, _ = torch.hub.load('snakers4/silero-models', 'silero_tts', language='ru', speaker='v4_ru', trust_repo=True)
for speaker in ['xenia', 'kseniya', 'baya']:
    for name, text in lines.items():
        audio = model.apply_tts(text=text, speaker=speaker, sample_rate=48000, put_accent=True, put_yo=True)
        sf.write(f'tts/out/{speaker}-{name}.wav', audio.numpy(), 48000)
        print(speaker, name, round(len(audio) / 48000, 2))
