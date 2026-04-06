const katex = { renderToString: (t, o) => { return true; } };

function renderAllMathMock(text) {
    const ranges = [];
    const delimiters = [
        { left: '$$', right: '$$', display: true },
        { left: '\\\[', right: '\\\]', display: true }, // \[\ in string?
        { left: '\\\(', right: '\\\)', display: false },
        { left: '$', right: '$', display: false }
    ];

    function isEscaped(str, index) {
        let backslashes = 0;
        for (let i = index - 1; i >= 0 && str[i] === '\\'; i--) backslashes++;
        return backslashes % 2 === 1;
    }

    function findNextLeft(str, from) {
        let best = null;
        for (const d of delimiters) {
            let i = str.indexOf(d.left, from);
            while (i !== -1 && isEscaped(str, i)) {
                i = str.indexOf(d.left, i + 1);
            }
            if (i !== -1 && (!best || i < best.index || (i === best.index && d.left.length > best.delim.left.length))) {
                best = { index: i, delim: d };
            }
        }
        return best;
    }

    function findRight(str, right, from) {
        let i = str.indexOf(right, from);
        while (i !== -1 && isEscaped(str, i)) {
            i = str.indexOf(right, i + 1);
        }
        return i;
    }

    let pos = 0;
    while (pos < text.length) {
        const leftHit = findNextLeft(text, pos);
        if (!leftHit) break;

        const start = leftHit.index;
        const contentStart = start + leftHit.delim.left.length;
        const endDelim = findRight(text, leftHit.delim.right, contentStart);

        if (endDelim === -1) {
            pos = contentStart;
            continue;
        }
        

        const contentEnd = endDelim;
        const latex = text.slice(contentStart, contentEnd).trim();
        if (latex) {
            ranges.push({
                start,
                end: endDelim + leftHit.delim.right.length,
                latex,
                display: leftHit.delim.display
            });
        }

        pos = endDelim + leftHit.delim.right.length;
    }
    
    return ranges;
}

const input = `Title: Math Rendering Test

This is an example of an inline equation: the area of a circle is $A = \\pi r^2$. Notice how the equation flows directly with the text. We can also write inline math like \\( E = mc^2 \\).

Now let's test a block display equation using double dollar signs:
$$ x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} $$

And here is another block equation using bracket delimiters:
\\[
\\int u \\, dv = uv - \\int v \\, du
\\]

That covers all the delimiters your app supports!

Title: Math Rendering Test

This is an example of an inline equation: the area of a circle is $A = \\pi r^2$. Notice how the equation flows directly with the text. We can also write inline math like \\( E = mc^2 \\).`;

const r = renderAllMathMock(input);

