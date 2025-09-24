import { processSchema, processImports } from './process.mjs';
import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';

describe('processImports', () => {
  const mockSchema = {
    types: {
      SomeType: {
        id: 'SomeType',
        type: 'object',
        properties: {
          name: { type: 'string' },
          value: { type: 'number' },
        },
      },
      AnotherType: {
        id: 'AnotherType',
        type: 'object',
        properties: {
          description: { type: 'string' },
        },
      },
    },
    namespaces: {
      TestNamespace: {
        namespace: 'TestNamespace',
        functions: {
          testFunction: {
            type: 'function',
            parameters: [],
          },
        },
      },
    },
  };

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('it processes arrays recursively', () => {
    const input = [
      { $import: 'SomeType' },
      { $import: 'AnotherType' },
      { normal: 'value' },
    ];

    const result = processImports(mockSchema, input);

    expect(result).toHaveLength(3);
    expect(result[0]).toHaveProperty('type', 'object');
    expect(result[0]).toHaveProperty('properties');
    expect(result[0]).not.toHaveProperty('$import');
    expect(result[0]).not.toHaveProperty('id');
    expect(result[1]).toHaveProperty('type', 'object');
    expect(result[2]).toEqual({ normal: 'value' });
  });

  test('it processes objects recursively', () => {
    const input = {
      level1: {
        level2: {
          $import: 'SomeType',
        },
      },
    };

    const result = processImports(mockSchema, input);

    expect(result.level1.level2).toHaveProperty('type', 'object');
    expect(result.level1.level2).toHaveProperty('properties');
    expect(result.level1.level2).not.toHaveProperty('$import');
  });

  test('it replaces $import with referenced type when procssing imports', () => {
    const input = {
      $import: 'SomeType',
      additionalProp: 'value',
    };

    const result = processImports(mockSchema, input);

    expect(result).toHaveProperty('type', 'object');
    expect(result).toHaveProperty('properties');
    expect(result).toHaveProperty('additionalProp', 'value');
    expect(result).not.toHaveProperty('$import');
    expect(result).not.toHaveProperty('id');
  });

  test('it handles $import with namespace prefix when processing imports', () => {
    const input = {
      $import: 'namespace.SomeType',
      additionalProp: 'value',
    };

    const result = processImports(mockSchema, input);

    expect(result).toHaveProperty('type', 'object');
    expect(result).toHaveProperty('properties');
    expect(result).toHaveProperty('additionalProp', 'value');
    expect(result).not.toHaveProperty('$import');
  });

  test('it merges imported properties with existing properties', () => {
    const input = {
      $import: 'SomeType',
      existingProp: 'existing',
      properties: {
        existingProperty: { type: 'boolean' },
      },
    };

    const result = processImports(mockSchema, input);

    expect(result).toHaveProperty('existingProp', 'existing');
    expect(result.properties).toHaveProperty('name');
    expect(result.properties).toHaveProperty('value');
    expect(result.properties).toHaveProperty('existingProperty');
  });

  test('it skips ManifestBase imports', () => {
    const input = {
      $import: 'ManifestBase',
      additionalProp: 'value',
    };

    const result = processImports(mockSchema, input);
    expect(result).toEqual(input);
    expect(result).toHaveProperty('$import', 'ManifestBase');
  });

  test('it logs missing imports', () => {
    const input = {
      $import: 'NonExistentType',
    };
    processImports(mockSchema, input);
    expect(console.log).toHaveBeenCalledWith(
      'Missing requested import: NonExistentType'
    );
  });

  test('it removes manifest version limits from imported content', () => {
    const schemaWithLimits = {
      types: {
        LimitedType: {
          id: 'LimitedType',
          type: 'object',
          min_manifest_version: 2,
          max_manifest_version: 3,
          properties: {
            test: { type: 'string' },
          },
        },
      },
    };

    const input = {
      $import: 'LimitedType',
    };

    const result = processImports(schemaWithLimits, input);

    expect(result).not.toHaveProperty('min_manifest_version');
    expect(result).not.toHaveProperty('max_manifest_version');
    expect(result).toHaveProperty('properties');
  });

  test('it removes namespace and id from imported content', () => {
    const input = {
      $import: 'TestNamespace',
    };

    const result = processImports(mockSchema, input);

    expect(result).not.toHaveProperty('namespace');
    expect(result).not.toHaveProperty('id');
    expect(result).toHaveProperty('functions');
  });

  test('it merges nested objects recursively', () => {
    const input = {
      $import: 'SomeType',
      properties: {
        existing: { type: 'string' },
        nested: {
          deeper: {
            $import: 'AnotherType',
          },
        },
      },
    };

    const result = processImports(mockSchema, input);

    expect(result.properties).toHaveProperty('name');
    expect(result.properties).toHaveProperty('value');
    expect(result.properties).toHaveProperty('existing');
    expect(result.properties.nested.deeper).toHaveProperty('type', 'object');
    expect(result.properties.nested.deeper).toHaveProperty('properties');
  });

  test('it handles arrays within imported content', () => {
    const schemaWithArrays = {
      types: {
        ArrayType: {
          id: 'ArrayType',
          type: 'object',
          properties: {
            items: [{ $import: 'SomeType' }, { $import: 'AnotherType' }],
          },
        },
      },
    };

    const input = {
      $import: 'ArrayType',
    };

    const result = processImports(schemaWithArrays, input);

    expect(result.properties.items).toHaveLength(2);
    expect(result.properties.items[0]).toHaveProperty('type', 'object');
    expect(result.properties.items[1]).toHaveProperty('type', 'object');
  });
});

describe('processSchema', () => {
  const baseConfig = {
    manifest_version: 3,
    urlReplacements: {
      'test-url': 'https://example.com/test',
      'docs-url': 'https://docs.example.com',
    },
  };

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('it filters objects by manifest version', async () => {
    const input = {
      prop1: { value: 'test1' },
      prop2: { value: 'test2', min_manifest_version: 3 },
      prop3: { value: 'test3', max_manifest_version: 2 },
      prop4: {
        value: 'test4',
        min_manifest_version: 2,
        max_manifest_version: 3,
      },
    };

    const result = await processSchema({ config: baseConfig, value: input });

    expect(result).toHaveProperty('prop1');
    expect(result).toHaveProperty('prop2');
    expect(result).not.toHaveProperty('prop3'); // should be excluded because max_manifest_version < 3
    expect(result).toHaveProperty('prop4');
  });

  test('it handles arrays and filter by manifest version', async () => {
    const input = [
      { value: 'test1' },
      { value: 'test2', min_manifest_version: 3 },
      { value: 'test3', max_manifest_version: 2 },
      { value: 'test4', min_manifest_version: 2, max_manifest_version: 3 },
    ];

    const result = await processSchema({ config: baseConfig, value: input });

    expect(result).toHaveLength(3);
    expect(result[0].value).toBe('test1');
    expect(result[1].value).toBe('test2');
    expect(result[2].value).toBe('test4');
  });

  test('should handle choices path elements correctly', async () => {
    const input = [
      { name: 'choice1', value: 'test1' },
      { name: 'choice2', value: 'test2' },
    ];
    const fullPath = [{ ref: 'choices', type: 'property' }];

    const result = await processSchema({
      config: baseConfig,
      value: input,
      fullPath,
    });

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('choice1');
    expect(result[1].name).toBe('choice2');
  });

  test('should add index path element for returns/items/additionalProperties', async () => {
    const input = { type: 'string' };
    const fullPath = [
      { ref: 'function', type: 'property' },
      { ref: 'returns', type: 'property' },
    ];

    const result = await processSchema({
      config: baseConfig,
      value: input,
      fullPath,
    });

    expect(result).toEqual({ type: 'string' });
  });

  describe('search path functionality', () => {
    test('should return value unchanged when searchPath does not match', async () => {
      const input = { test: 'value' };
      const searchPath = [{ ref: 'different', type: 'property' }];

      const result = await processSchema({
        config: baseConfig,
        value: input,
        searchPath,
      });

      expect(result).toEqual(input);
    });

    test('should mark searchPath as found when exact match', async () => {
      const input = { test: 'value' };
      const searchPath = [{ ref: 'test', type: 'property' }];

      const result = await processSchema({
        config: baseConfig,
        value: input,
        fullPath: [{ ref: 'test', type: 'property' }],
        searchPath,
      });

      expect(searchPath.found).toBe(true);
      expect(result).toEqual(input);
    });

    test('should handle choices~0 special case', async () => {
      const input = { test: 'value' };
      const searchPath = [
        { ref: 'parent', type: 'property' },
        { ref: 'choices', type: 'property' },
        { ref: '0', type: 'idx' },
      ];

      const result = await processSchema({
        config: baseConfig,
        value: input,
        fullPath: [{ ref: 'parent', type: 'property' }],
        searchPath,
      });

      expect(searchPath.found).toBe(true);
      expect(result).toEqual(input);
    });
  });

  describe('edge cases', () => {
    test('should handle empty objects', async () => {
      const result = await processSchema({ config: baseConfig, value: {} });
      expect(result).toEqual({});
    });

    test('should handle empty arrays', async () => {
      const result = await processSchema({ config: baseConfig, value: [] });
      expect(result).toEqual([]);
    });

    test('should handle nested empty structures', async () => {
      const input = {
        emptyObj: {},
        emptyArr: [],
        nested: { deeper: {} },
      };

      const result = await processSchema({ config: baseConfig, value: input });
      expect(result).toEqual(input);
    });

    test('should handle $extend properties', async () => {
      const input = {
        $extend: 'SomeType',
        additionalProp: 'value',
      };

      const result = await processSchema({ config: baseConfig, value: input });
      expect(result).toEqual(input);
    });
  });
});
