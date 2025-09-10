export function dashedUUID(uuid: string): string {
  if (!/^[0-9a-fA-F]{32}$/.test(uuid)) {
    throw new Error(`Invalid undashed UUID: ${uuid}`)
  }
  return uuid.replace(
    /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
    "$1-$2-$3-$4-$5"
  )
}