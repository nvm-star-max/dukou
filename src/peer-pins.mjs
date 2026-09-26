export function pinPeerKeys(pins, devices) {
  for (const device of devices) {
    const expected = pins[device.id];
    if (
      expected &&
      (expected.signingPublic !== device.signingPublic ||
        expected.encryptionPublic !== device.encryptionPublic)
    )
      throw new Error(
        `设备 ${device.name} 的密钥已变更；已阻止连接，请核对指纹后重新配对`,
      );
  }
  let changed = false;
  for (const device of devices) {
    if (pins[device.id]) continue;
    pins[device.id] = {
      signingPublic: device.signingPublic,
      encryptionPublic: device.encryptionPublic,
    };
    changed = true;
  }
  return changed;
}
