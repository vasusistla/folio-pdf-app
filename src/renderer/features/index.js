/**
 * The list of features the app loads, in order.
 * To add a feature: create a file in this folder and add it here.
 * To switch one off: comment out its line.
 */
import files from './files.js';
import links from './links.js';
import save from './save.js';
import print from './print.js';
import edit from './edit.js';
import sidebar from './sidebar.js';
import thumbnails from './thumbnails.js';
import outline from './outline.js';
import navigation from './navigation.js';
import zoom from './zoom.js';
import layout from './layout.js';
import search from './search.js';
import annotate from './annotate.js';
import pages from './pages.js';
import pageNumbers from './page-numbers.js';
import fillSign from './fill-sign/index.js';
import scan from './scan/index.js';
import touch from './touch.js';
import presentation from './presentation.js';
import theme from './theme.js';
import properties from './properties.js';
import help from './help.js';

export const FEATURES = [
  files,
  links,
  save,
  print,
  edit,
  sidebar,
  thumbnails,
  outline,
  navigation,
  zoom,
  touch,
  layout,
  search,
  annotate,
  pages,
  pageNumbers,
  fillSign,
  scan,
  presentation,
  theme,
  properties,
  help,
];
