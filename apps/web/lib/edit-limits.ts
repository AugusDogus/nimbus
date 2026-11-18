const megabyte = 1024 * 1024;

/**
 * How large a text file the browser editor handles: it opens files up to `open` bytes, the
 * part of a file a preview loads, and saves up to `save` bytes, so edits can make a file
 * larger. The server enforces `save`; the editor checks it first and says so in the same words.
 */
export const EditLimits = {
  open: megabyte,
  save: 5 * megabyte,
  /** Whole megabytes, for messages. */
  megabytes: (bytes: number) => Math.round(bytes / megabyte),
  /** The message for an edit larger than `save`. */
  tooLarge: () =>
    `Edited files can be at most ${EditLimits.megabytes(EditLimits.save)} MB. The file on the server is unchanged. Shorten the text, or download the file and edit it on your device.`,
} as const;
