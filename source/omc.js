import * as protobuf from './protobuf.js';

const omc = {};

omc.ModelFactory = class {

    async match(context) {
        const stream = context.stream;
        if (stream && stream.length >= 256) {
            const header = stream.peek(84);
            if (header[0] === 0x49 && header[1] === 0x4d && header[2] === 0x4f && header[3] === 0x44 && [4, 10].includes(header[82])) {
                return context.set('omc');
            }
        }
        return null;
    }

    async open(context) {
        const stream = context.stream;
        const prefix = stream.peek(84);
        const header = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
        if (header.getUint8(80) !== 0) {
            throw new Error('Encrypted HiAI OMC model.');
        }
        const headerSize = header.getUint32(4, true);
        if (headerSize < 256 || headerSize > stream.length - 4) {
            throw new Error('Invalid HiAI OMC header size.');
        }
        const range = (offset, size) => {
            const position = stream.position;
            try {
                stream.seek(offset);
                return typeof stream.read === 'function' ? stream.read(size) : stream.peek(size);
            } finally {
                stream.seek(position);
            }
        };
        const view = (offset, size) => {
            const bytes = range(offset, size);
            return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        };
        const count = view(headerSize, 4).getUint32(0, true);
        let partitions = null;
        for (const word of [4, 8]) {
            const size = word * (1 + count * 3);
            if (count === 0 || count > 256 || size > stream.length - headerSize) {
                continue;
            }
            const table = view(headerSize, size);
            const read = (index) => word === 4 ? table.getUint32(index * word, true) : Number(table.getBigUint64(index * word, true));
            const map = new Map();
            const base = headerSize + size;
            for (let i = 0; i < count; i++) {
                const type = read(1 + i * 3);
                const offset = read(2 + i * 3);
                const length = read(3 + i * 3);
                if (type >= 32 || map.has(type) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
                    offset > stream.length - base || length > stream.length - base - offset) {
                    break;
                }
                map.set(type, { offset: base + offset, length });
            }
            if (map.size === count && map.has(0)) {
                partitions = map;
                break;
            }
        }
        if (!partitions) {
            throw new Error('Invalid HiAI OMC partition table.');
        }
        const schema = (await context.require('./om-proto')).ge.proto;
        const model = partitions.get(0);
        const proto = schema.ModelDef.decode(protobuf.BinaryReader.open(range(model.offset, model.length)));
        if (!proto.graph.length) {
            throw new Error('No embedded graph in HiAI OMC model.');
        }
        const metadata = await context.metadata('om-metadata.json');
        const weights = partitions.get(1);
        const region = weights ? { size: weights.length, read: (offset, size) => range(weights.offset + offset, size) } : null;
        const modules = [];
        for (const graph of proto.graph) {
            const nested = [];
            modules.push(new omc.Graph(graph, schema, metadata, region, nested), ...nested);
        }
        const modelMetadata = [{ name: 'container model type', value: String(header.getUint8(82)) }];
        for (const [id, label] of [[0, 'model'], [1, 'weights'], [2, 'tasks']]) {
            if (partitions.has(id)) {
                const { offset, length } = partitions.get(id);
                modelMetadata.push({ name: `${label} partition`, value: `${length} bytes at file offset ${offset}` });
            }
        }
        return { format: 'HiAI OMC', name: proto.name, modules, metadata: modelMetadata };
    }
};

omc.Graph = class {

    constructor(graph, schema, metadata, region, nested) {
        this.name = graph.name;
        this.nodes = [];
        this.inputs = [];
        this.outputs = [];
        const values = new Map();
        const value = (name, desc) => {
            if (!values.has(name)) {
                values.set(name, { name, type: omc.type(schema, desc), initializer: null });
            }
            return values.get(name);
        };
        // Create outputs first; the serialized operation order need not be topological.
        for (const op of graph.op) {
            for (const [index, desc] of op.output_desc.entries()) {
                const v = value(`${op.name}:${index}`, desc);
                const tensor = op.attr.value && op.attr.value.t;
                if (op.type === 'Const' && tensor && index === 0) {
                    const type = omc.type(schema, tensor.desc) || v.type;
                    const offset = Number(tensor.desc?.attr?.merged_offset?.i ?? tensor.desc?.data_offset);
                    const length = Number(tensor.desc?.weight_size);
                    const valid = region && Number.isSafeInteger(offset) && Number.isSafeInteger(length) &&
                        offset >= 0 && length > 0 && offset <= region.size && length <= region.size - offset;
                    v.initializer = { type, category: 'Constant', encoding: '<', get values() {
                        if (tensor.data.length) {
                            return tensor.data;
                        }
                        return valid ? region.read(offset, length) : null;
                    } };
                }
            }
        }
        const arg = (name, v) => ({ name, value: [v] });
        for (const op of graph.op) {
            const ins = [];
            const control = [];
            for (const [i, input] of op.input.entries()) {
                if (!input) {
                    continue;
                }
                if (input.endsWith(':-1')) {
                    control.push(value(`${input.slice(0, -3)}:0`));
                    continue;
                }
                const desc = op.input_desc[i];
                ins.push(arg(desc?.name || op.input_name[i] || String(i), value(input, desc)));
            }
            const outs = op.output_desc.map((desc, i) => arg(desc.name || String(i), value(`${op.name}:${i}`, desc)));
            if (op.type === 'Data') {
                for (const [i, out] of outs.entries()) {
                    this.inputs.push(arg(op.output_desc[i].name || (outs.length === 1 ? op.name : out.value[0].name), out.value[0]));
                }
                continue;
            }
            if (op.type === 'NetOutput') {
                for (const [i, input] of ins.entries()) {
                    this.outputs.push(arg(op.output_desc[i]?.name || op.input_desc[i]?.name || input.value[0].name, input.value[0]));
                }
                continue;
            }
            if (op.type === 'Const' && outs[0]?.value[0].initializer) {
                continue;
            }
            const node = { name: op.name, type: metadata.type(op.type) || { name: op.type }, inputs: ins, outputs: outs,
                controlDependencies: control, attributes: [] };
            // GE map serialization can put branches1 before branches0. The Case list defines dispatch order.
            const branches = (op.type === 'Case' ? op.attr.branches?.list?.s : null) || [];
            const keys = new Set([...branches.map((key) => new TextDecoder().decode(key)), ...Object.keys(op.attr)]);
            for (const name of keys) {
                const attr = op.attr[name];
                if (!attr) {
                    continue;
                }
                if (op.type === 'GraphOp' && name === 'subgraph' && (attr.bt?.length || attr.g)) {
                    const sub = attr.g || schema.GraphDef.decode(protobuf.BinaryReader.open(attr.bt));
                    const offset = Number(op.attr.graphop_weight_offset?.i ?? 0);
                    const size = Number(op.attr.graphop_weight_size?.i ?? region?.size ?? 0);
                    const subregion = region && offset >= 0 && size >= 0 && size <= region.size - offset ?
                        { size, read: (start, length) => region.read(offset + start, length) } : null;
                    node.type = new omc.Graph(sub, schema, metadata, subregion, nested);
                    node.type.type = 'function';
                    node.type.identifier = op.type;
                    nested.push(node.type);
                } else if (attr.g) {
                    const descendants = [];
                    const branch = new omc.Graph(attr.g, schema, metadata, region, descendants);
                    // Branches commonly reuse the same GE device subgraph name.
                    for (const child of descendants) {
                        child.name = `${branch.name}/${child.name}`;
                    }
                    node.attributes.push({ name, type: 'graph', value: branch });
                    nested.push(branch, ...descendants);
                } else {
                    const display = omc.attribute(attr);
                    if (display !== undefined) {
                        node.attributes.push({ name, value: display, type: 'attribute' });
                    }
                }
            }
            this.nodes.push(node);
        }
    }
};

omc.type = (schema, desc) => {
    if (!desc) {
        return null;
    }
    const dataType = Object.entries(schema.DataType).find(([, id]) => id === desc.dtype)?.[0]?.slice(3).toLowerCase();
    const aliases = { float: 'float32', double: 'float64', bool: 'boolean', bf16: 'bfloat16', undefined: '?' };
    const dims = desc.shape?.dim.map(Number);
    const shape = { dimensions: dims || [], toString: () => dims?.length ? `[${dims.join(',')}]` : '' };
    return { dataType: aliases[dataType] || dataType || '?', shape, denotation: desc.layout,
        toString() {
            return this.dataType + this.shape.toString();
        } };
};

omc.attribute = (attr) => {
    const text = (bytes) => {
        const string = new TextDecoder('utf-8').decode(bytes);
        return Array.from(string).some((c) => c === '\ufffd' || (c < ' ' && !'\n\r\t'.includes(c))) ? `bytes[${bytes.length}]` : string;
    };
    switch (attr.value) {
        case 'i': case 'dt': return attr[attr.value].toString();
        case 'f': case 'b': return attr[attr.value];
        case 's': return text(attr.s);
        case 'bt': return `bytes[${attr.bt.length}]`;
        case 'list': {
            for (const key of ['s', 'i', 'f', 'b', 'type']) {
                const list = attr.list[key];
                if (list && list.length) {
                    return list.map((item) => key === 's' ? text(item) : item.toString()).join(', ');
                }
            }
            return undefined;
        }
        default: return undefined;
    }
};

export const ModelFactory = omc.ModelFactory;
