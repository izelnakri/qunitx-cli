import { Chalk } from 'chalk';

const COLOR_LEVEL = process.env.NO_COLOR || process.env.NODE_DISABLE_COLORS || process.env.DENO_NO_COLOR ? 0 : 3;
const chalk = new Chalk({ level: COLOR_LEVEL });

export default function addBorderToText(string, borderColor = '#EEEEEE') {
  let color = chalk.hex(borderColor);
  let splitString = string.split('\n');
  let longestLineLength = splitString
    .reduce((result, stringLine) => result > stringLine.length ? result : stringLine.length, 0);
  let verticalBorder = color('-'.repeat(longestLineLength + 4));
  let content = splitString.reduce((result, stringLine) => {
    let spaces = ' '.repeat(longestLineLength - stringLine.length);

    result.push(`${color('|')} ${stringLine}${spaces} ${color('|')}\n`);

    return result;
  }, []);

  return `${verticalBorder}\n${content.join('')}${verticalBorder}`;
}
