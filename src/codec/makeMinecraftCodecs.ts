import mc from "minecraft-protocol"

export function makeMinecraftCodecs(state: mc.States, version: string, isServer: boolean) {
  const serializer = mc.createSerializer({ state, isServer, version, customPackets: [] })
  const deserializer = mc.createDeserializer({ state, isServer, version, customPackets: [] })
  return { serializer, deserializer }
}