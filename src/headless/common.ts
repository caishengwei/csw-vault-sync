import { sha256 as hash256 } from '@noble/hashes/sha2'
import { md5 as hashMd5, sha1 as hashSha1 } from '@noble/hashes/legacy'
import { bytesToHex } from '@noble/hashes/utils'
import { fromUint8Array, toUint8Array } from 'js-base64'
import { FileEntry, SyncError } from './types'

export const encode = (text: string) => new TextEncoder().encode(text)
const hashBytes = (content: Uint8Array) => {
	const { buffer, byteOffset, byteLength } = content
	return content instanceof Uint8Array
		? content
		: new Uint8Array(buffer, byteOffset, byteLength)
}
export const sha256 = (content: Uint8Array) =>
	bytesToHex(hash256(hashBytes(content)))
export const md5Hex = (content: Uint8Array) =>
	bytesToHex(hashMd5(hashBytes(content)))
export const sha1Hex = (content: Uint8Array) =>
	bytesToHex(hashSha1(hashBytes(content)))
export const md5Base64 = (content: Uint8Array) =>
	fromUint8Array(hashMd5(hashBytes(content)))
export const toBase64 = fromUint8Array
export const fromBase64 = toUint8Array

export function randomUUID() {
	const bytes = globalThis.crypto?.getRandomValues(new Uint8Array(16))
	if (!bytes)
		throw new SyncError('CRYPTO_UNAVAILABLE', '当前设备不支持安全随机数')
	bytes[6] = (bytes[6] & 15) | 64
	bytes[8] = (bytes[8] & 63) | 128
	const hex = bytesToHex(bytes)
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function matchesEntry(
	current: FileEntry | undefined,
	expected: FileEntry | undefined,
) {
	return !current || !expected
		? current === expected
		: current.kind === expected.kind && current.revision === expected.revision
}
