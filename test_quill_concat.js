const Delta = require('quill-delta');
let ops1 = [{insert: "A\n"}];
let ops2 = [{insert: "B\n"}];
let d1 = new Delta(ops1);
let d2 = new Delta(ops2);

let d1s = d1.slice(0, d1.length()-1);
console.log(d1s.concat(d2));
