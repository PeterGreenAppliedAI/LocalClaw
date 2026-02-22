import { describe, it, expect } from 'vitest';
import { isPrivateIpAddress, isBlockedHostname } from '../../src/tools/ssrf.js';

describe('isPrivateIpAddress', () => {
  it('blocks 127.0.0.1 (loopback)', () => {
    expect(isPrivateIpAddress('127.0.0.1')).toBe(true);
  });

  it('blocks 10.x.x.x (private)', () => {
    expect(isPrivateIpAddress('10.0.0.1')).toBe(true);
    expect(isPrivateIpAddress('10.255.255.255')).toBe(true);
  });

  it('blocks 192.168.x.x (private)', () => {
    expect(isPrivateIpAddress('192.168.1.1')).toBe(true);
  });

  it('blocks 172.16-31.x.x (private)', () => {
    expect(isPrivateIpAddress('172.16.0.1')).toBe(true);
    expect(isPrivateIpAddress('172.31.255.255')).toBe(true);
    expect(isPrivateIpAddress('172.15.0.1')).toBe(false);
    expect(isPrivateIpAddress('172.32.0.1')).toBe(false);
  });

  it('blocks 169.254.x.x (link-local)', () => {
    expect(isPrivateIpAddress('169.254.1.1')).toBe(true);
  });

  it('blocks 0.x.x.x', () => {
    expect(isPrivateIpAddress('0.0.0.0')).toBe(true);
  });

  it('blocks CGN range 100.64-127.x.x', () => {
    expect(isPrivateIpAddress('100.64.0.1')).toBe(true);
    expect(isPrivateIpAddress('100.127.255.255')).toBe(true);
    expect(isPrivateIpAddress('100.63.0.1')).toBe(false);
    expect(isPrivateIpAddress('100.128.0.1')).toBe(false);
  });

  it('allows public IPs', () => {
    expect(isPrivateIpAddress('8.8.8.8')).toBe(false);
    expect(isPrivateIpAddress('1.1.1.1')).toBe(false);
    expect(isPrivateIpAddress('142.250.80.46')).toBe(false);
  });

  it('blocks IPv6 loopback', () => {
    expect(isPrivateIpAddress('::1')).toBe(true);
    expect(isPrivateIpAddress('::')).toBe(true);
  });

  it('blocks IPv6 link-local', () => {
    expect(isPrivateIpAddress('fe80::1')).toBe(true);
  });

  it('blocks IPv6 unique local', () => {
    expect(isPrivateIpAddress('fc00::1')).toBe(true);
    expect(isPrivateIpAddress('fd12::1')).toBe(true);
  });

  it('blocks IPv4-mapped IPv6', () => {
    expect(isPrivateIpAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIpAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIpAddress('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('isBlockedHostname', () => {
  it('blocks localhost', () => {
    expect(isBlockedHostname('localhost')).toBe(true);
  });

  it('blocks metadata.google.internal', () => {
    expect(isBlockedHostname('metadata.google.internal')).toBe(true);
  });

  it('blocks .localhost suffix', () => {
    expect(isBlockedHostname('evil.localhost')).toBe(true);
  });

  it('blocks .local suffix', () => {
    expect(isBlockedHostname('myserver.local')).toBe(true);
  });

  it('blocks .internal suffix', () => {
    expect(isBlockedHostname('api.internal')).toBe(true);
  });

  it('allows public hostnames', () => {
    expect(isBlockedHostname('google.com')).toBe(false);
    expect(isBlockedHostname('api.example.com')).toBe(false);
  });
});
