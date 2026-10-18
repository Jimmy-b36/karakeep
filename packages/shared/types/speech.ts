import { z } from "zod";

// UTF-16 text offsets and seconds within the exact generated WAV.
export const zSpeechWord = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().positive(),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().nonnegative(),
});
export type SpeechWord = z.infer<typeof zSpeechWord>;

export const zTimedSpeech = z.object({
  audio: z.string().min(1).max(45_000_000),
  words: z.array(zSpeechWord).min(1).max(2000),
  duration: z.number().finite().positive().max(600),
});

export function validSpeechWords(
  words: SpeechWord[],
  text: string,
  duration: number,
): boolean {
  return words.every(
    (word, index) =>
      word.from < word.to &&
      word.to <= text.length &&
      word.start <= word.end &&
      word.end <= duration + 0.1 &&
      (index === 0 ||
        (word.start >= words[index - 1]!.start &&
          word.from >= words[index - 1]!.to)),
  );
}
