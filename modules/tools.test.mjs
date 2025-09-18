import { sortKeys, validateUrl, getJsonFiles } from './tools.mjs';
import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';

global.fetch = jest.fn();

const originalConsoleLog = console.log;
let consoleOutput = [];

beforeEach(() => {
  consoleOutput = [];
  console.log = jest.fn((...args) => {
    consoleOutput.push(args.join(' '));
  });
});

afterEach(() => {
  console.log = originalConsoleLog;
  jest.clearAllMocks();
});

describe('getJsonFiles', () => {
  let readdirSpy;
  let extnameSpy;

  beforeEach(() => {
    readdirSpy = jest.spyOn(fs, 'readdir');
    extnameSpy = jest.spyOn(path, 'extname');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('it returns JSON files from a folder', async () => {
    const mockFiles = [
      { name: 'file1.json', isDirectory: () => false },
      { name: 'file2.json', isDirectory: () => false },
      { name: 'file3.txt', isDirectory: () => false },
      { name: 'subfolder', isDirectory: () => true },
    ];

    readdirSpy.mockResolvedValue(mockFiles);
    extnameSpy
      .mockReturnValueOnce('.json')
      .mockReturnValueOnce('.json')
      .mockReturnValueOnce('.txt');

    const result = await getJsonFiles('/test/path');

    expect(readdirSpy).toHaveBeenCalledWith('/test/path', {
      withFileTypes: true,
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: 'file1.json', path: '/test/path' });
    expect(result[1]).toEqual({ name: 'file2.json', path: '/test/path' });
  });

  test('it filters out directories', async () => {
    const mockFiles = [
      { name: 'file1.json', isDirectory: () => false },
      { name: 'subfolder', isDirectory: () => true },
      { name: 'file2.json', isDirectory: () => false },
    ];

    readdirSpy.mockResolvedValue(mockFiles);
    extnameSpy.mockReturnValueOnce('.json').mockReturnValueOnce('.json');

    const result = await getJsonFiles('/test/path');

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('file1.json');
    expect(result[1].name).toBe('file2.json');
  });

  test('it filters out non-JSON files', async () => {
    const mockFiles = [
      { name: 'file1.json', isDirectory: () => false },
      { name: 'file2.txt', isDirectory: () => false },
      { name: 'file3.js', isDirectory: () => false },
    ];

    readdirSpy.mockResolvedValue(mockFiles);
    extnameSpy
      .mockReturnValueOnce('.json')
      .mockReturnValueOnce('.txt')
      .mockReturnValueOnce('.js');

    const result = await getJsonFiles('/test/path');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('file1.json');
  });

  test('it handles empty folder', async () => {
    readdirSpy.mockResolvedValue([]);

    const result = await getJsonFiles('/empty/path');

    expect(result).toHaveLength(0);
    expect(readdirSpy).toHaveBeenCalledWith('/empty/path', {
      withFileTypes: true,
    });
  });

  test('it handles folder with no JSON files', async () => {
    const mockFiles = [
      { name: 'file1.txt', isDirectory: () => false },
      { name: 'file2.js', isDirectory: () => false },
      { name: 'subfolder', isDirectory: () => true },
    ];

    readdirSpy.mockResolvedValue(mockFiles);
    extnameSpy.mockReturnValueOnce('.txt').mockReturnValueOnce('.js');

    const result = await getJsonFiles('/test/path');

    expect(result).toHaveLength(0);
  });

  test('it handles fs.readdir errors', async () => {
    const error = new Error('Permission denied');
    readdirSpy.mockRejectedValue(error);

    await expect(getJsonFiles('/inaccessible/path')).rejects.toThrow(
      'Permission denied'
    );
  });

  test('it preserves folder path in results', async () => {
    const mockFiles = [
      { name: 'file1.json', isDirectory: () => false },
      { name: 'file2.json', isDirectory: () => false },
    ];

    readdirSpy.mockResolvedValue(mockFiles);
    extnameSpy.mockReturnValueOnce('.json').mockReturnValueOnce('.json');

    const result = await getJsonFiles('/custom/path/to/folder');

    expect(result).toHaveLength(2);
    expect(result[0].path).toBe('/custom/path/to/folder');
    expect(result[1].path).toBe('/custom/path/to/folder');
  });
});

describe('sortKeys', () => {
  test('should sort object keys alphabetically', () => {
    const input = { c: 3, a: 1, b: 2 };
    const expected = { a: 1, b: 2, c: 3 };
    expect(sortKeys(input)).toEqual(expected);
  });

  test('should handle nested arrays and objects', () => {
    const input = {
      b: [
        { d: 4, c: 3 },
        { f: 6, e: 5 },
      ],
      a: { z: 2, y: 1 },
    };
    const expected = {
      a: { y: 1, z: 2 },
      b: [
        { c: 3, d: 4 },
        { e: 5, f: 6 },
      ],
    };
    expect(sortKeys(input)).toEqual(expected);
  });

  test('should handle mixed content arrays', () => {
    const input = [{ b: 2, a: 1 }, 42, 'string', { d: 4, c: 3 }];
    const expected = [{ a: 1, b: 2 }, 42, 'string', { c: 3, d: 4 }];
    expect(sortKeys(input)).toEqual(expected);
  });
});

describe('validateUrl', () => {
  test('should return true for successful response', async () => {
    const mockResponse = { ok: true };
    global.fetch.mockResolvedValue(mockResponse);

    const result = await validateUrl('https://example.com');

    expect(result).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith('https://example.com', {
      method: 'GET',
      redirect: 'follow',
    });
    expect(console.log).not.toHaveBeenCalled();
  });

  test('should return false and log error for non-ok response', async () => {
    const mockResponse = { ok: false, status: 404 };
    global.fetch.mockResolvedValue(mockResponse);

    const result = await validateUrl(
      'https://example.com/notfound',
      'test-domain'
    );

    expect(result).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith('https://example.com/notfound', {
      method: 'GET',
      redirect: 'follow',
    });
    expect(consoleOutput).toContain(
      ' - problematic URL found: 404 - test-domain - https://example.com/notfound'
    );
  });

  test('should return false and log error for network error', async () => {
    const networkError = new Error('Network error');
    global.fetch.mockRejectedValue(networkError);

    const result = await validateUrl('https://invalid-url.com', 'test-domain');

    expect(result).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith('https://invalid-url.com', {
      method: 'GET',
      redirect: 'follow',
    });
    expect(consoleOutput).toContain(
      ' - problematic URL found: network error - test-domain - https://invalid-url.com'
    );
  });
});
