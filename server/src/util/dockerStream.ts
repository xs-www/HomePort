/**
 * Docker 日志流解复用。
 *
 * Docker daemon 对**非 TTY** 容器返回的日志流是带 8 字节头部的多路复用格式：
 * `[streamType(1)][0][0][0][size(4, big-endian)]` + payload。
 * TTY 容器则是裸字节流。本模块负责两种情况的统一解码。
 */

const HEADER_SIZE = 8;

/** 头部 stream 类型。 */
export const STREAM_STDOUT = 1;
export const STREAM_STDERR = 2;

export interface DemuxResult {
  stdout: string;
  /** stderr 输出（已从 stdout 中分离） */
  stderr: string;
  combined: string;
}

/**
 * 尝试把 buffer 当作多路复用流解码。
 *
 * @param buffer Docker 返回的原始 buffer
 * @param isTty 容器是否分配了 TTY（true 时直接当作文本）
 * @returns 分离后的 stdout / stderr / combined（按原始顺序拼接）
 */
export function demuxDockerLogs(buffer: Buffer, isTty: boolean): DemuxResult {
  if (isTty) {
    const text = buffer.toString('utf8');
    return { stdout: text, stderr: '', combined: text };
  }

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const combinedChunks: string[] = [];

  let offset = 0;
  let sawValidFrame = false;

  while (offset + HEADER_SIZE <= buffer.length) {
    const streamType = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);

    // 头部合法性校验：大小必须落在剩余字节内且 stream 类型已知
    if ((streamType !== STREAM_STDOUT && streamType !== STREAM_STDERR) || offset + HEADER_SIZE + size > buffer.length) {
      break;
    }

    sawValidFrame = true;
    const payload = buffer.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + size).toString('utf8');
    combinedChunks.push(payload);
    if (streamType === STREAM_STDERR) stderrChunks.push(payload);
    else stdoutChunks.push(payload);

    offset += HEADER_SIZE + size;
  }

  // 完全没有有效帧 → 视为裸文本（例如某些驱动直接返回纯文本）
  if (!sawValidFrame) {
    const text = buffer.toString('utf8');
    return { stdout: text, stderr: '', combined: text };
  }

  // 尾部残余字节（不完整帧）按文本追加，避免丢日志
  if (offset < buffer.length) {
    const tail = buffer.subarray(offset).toString('utf8');
    combinedChunks.push(tail);
    stdoutChunks.push(tail);
  }

  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    combined: combinedChunks.join(''),
  };
}
