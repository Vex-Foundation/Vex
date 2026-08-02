import { CH } from "../../shared/ipc/channels.js";
import {
  imagesDeleteInputSchema,
  imagesListInputSchema,
  imagesReadThumbInputSchema,
  imagesUploadInputSchema,
  type ImagesDeleteInput,
  type ImagesListInput,
  type ImagesReadThumbInput,
  type ImagesUploadInput,
} from "../../shared/schemas/images.js";
import type { ImagesBridge } from "../../shared/types/bridge/agent/images.js";
import { invokeWithSchema } from "../_dispatch.js";

/**
 * Image locker (C2) domain wrapper. Four named domain methods and nothing
 * else — no channel string, no `ipcRenderer`, and in particular no way for
 * the renderer to name a file: `upload` carries an empty payload because main
 * owns the picker.
 */
export const images = {
  list(input: ImagesListInput) {
    return invokeWithSchema(CH.images.list, input, imagesListInputSchema);
  },
  upload(input: ImagesUploadInput) {
    return invokeWithSchema(CH.images.upload, input, imagesUploadInputSchema);
  },
  delete(input: ImagesDeleteInput) {
    return invokeWithSchema(CH.images.delete, input, imagesDeleteInputSchema);
  },
  readThumb(input: ImagesReadThumbInput) {
    return invokeWithSchema(CH.images.readThumb, input, imagesReadThumbInputSchema);
  },
} satisfies ImagesBridge;
