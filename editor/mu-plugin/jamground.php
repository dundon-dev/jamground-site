<?php
/**
 * Jamground mu-plugin.
 *
 * Not installed by Composer or a plugin zip: the shell writes this file into the
 * Playground WASM filesystem at wp-content/mu-plugins/jamground.php after boot
 * (see entry.mjs). The blueprint carries no content.
 *
 * The allowlist below is a content-quality and round-trip mechanism, never a security
 * control — Playground cannot enforce authorization, so least privilege is
 * enforced entirely at the GitHub layer.
 *
 * Thirteen hooks, in this order. The first five narrow what can be WRITTEN; the rest narrow
 * what is SHOWN, and the last points WordPress's own site links at the site:
 *   0. init                        — register the jamground_author post type
 *   1. allowed_block_types_all     — the inserter allowlist, per post type
 *   2. register_block_type_args    — strips supports before registration
 *   3. enqueue_block_assets        — shared block stylesheet
 *   4. admin_init                  — suppress the welcome guide
 *   5. admin_menu                  — remove the menus nothing here can act on
 *   6. admin_bar_menu              — remove the nodes that lead out of the product
 *   7. wp_dashboard_setup          — remove the welcome panel and every core widget
 *   8. admin_init / update_footer  — update nags and the version chrome
 *   9. admin_head                  — remove the help tabs
 *  10. enqueue_block_editor_assets — the inline-format allowlist (the file's only JS)
 *  11. init                        — drop the panels and taxonomies nothing reads back
 *  12. post_link / preview_post_link / admin_bar_menu — site links point at the site
 *
 * No jamground/* block is registered here: this release ships none, so the allowlist below
 * is core blocks only.
 */

// 0. The author post type.
//
// Pages and posts already have somewhere to live in wp-admin, because WordPress ships those
// types itself. An author has nowhere at all, and until it does the editor's own claim — that
// what is in wp-admin is what the site serves — is false for one of the three kinds of thing
// the site serves.
//
//   public       => false   an author has no WordPress front end. The site renders its own
//                           author pages from the content repository; a WordPress permalink
//                           for one would be a second, wrong address for the same person.
//   show_ui      => true    which is what puts it in the admin menu, and is the whole point.
//                           `show_in_menu` follows `show_ui` by default, so it gets its own
//                           top-level entry rather than hiding under another type's.
//   show_in_rest => true    the block editor and the modern admin data layer both read the
//                           REST index; a type absent from it is invisible to them.
//   supports     => title   THE TITLE AND NOTHING ELSE. An author is not a document: the
//                           contract's `Author` has no `blocks` field, so there is no body to
//                           edit and nowhere to keep one. Declaring only `title` is what makes
//                           WordPress offer a headline and an address and no canvas at all,
//                           rather than offering a canvas whose contents could never be saved.
//                           `name`, `role` and `bio` are carried through the save untouched
//                           and are not edited here yet.
//
// Registered on `init`, so it exists before anything inserts a row: entry.mjs writes this file
// into the WASM filesystem BEFORE it imports, and import.mjs's PHP begins with
// `require wp-load.php`, which loads mu-plugins and fires `init` before `wp_insert_post` runs.
add_action('init', function () {
    register_post_type('jamground_author', [
        'labels' => [
            'name'               => 'Authors',
            'singular_name'      => 'Author',
            'menu_name'          => 'Authors',
            'add_new_item'       => 'Add New Author',
            'edit_item'          => 'Edit Author',
            'new_item'           => 'New Author',
            'view_item'          => 'View Author',
            'search_items'       => 'Search Authors',
            'not_found'          => 'No authors found',
            'not_found_in_trash' => 'No authors found in Trash',
            'all_items'          => 'All Authors',
        ],
        'public'       => false,
        'show_ui'      => true,
        'show_in_rest' => true,
        'supports'     => ['title'],
        'menu_icon'    => 'dashicons-admin-users',
        // Pages is 20 and Comments — removed in section 5 — was 25, so this seats Authors
        // directly below Pages instead of at the bottom, where an unpositioned type lands.
        'menu_position' => 22,
        'has_archive'  => false,
        'rewrite'      => false,
    ]);
});

// 1. The inserter allowlist, PER POST TYPE. core/list-item is required for core/list to
// function and is never itself an inserter entry, so its absence from the inserter is not
// asserted.
//
// An author has no blocks — not "no blocks yet", but none by construction, because `Author`
// has no `blocks` field for one to be written into. Offering an inserter full of blocks that
// cannot be saved would be an invitation to lose work, so the honest allowlist for that type
// is the empty one. Every other type keeps the eight core blocks.
//
// `core/image` IS NOT AMONG THEM, and its absence is the same argument one line up. The
// contract has an `image` block and Astro renders one, but neither mapper will carry it:
// blocks-to-wp.mjs's `default` arm and export.mjs's both name it and throw, because there is
// no media upload path yet. While it sat in this list an editor could insert an image and
// then discover, at save time, that the work could not be written anywhere. It belongs back
// here the moment that path exists — and nowhere else has to change for it to come back,
// because attribute-guard.mjs already allows its three attributes.
//
// The signature is `10, 2` rather than `10, 0` so the filter receives the block editor's
// context and can answer differently per type. `$context->post` is null in the contexts that
// have no post at all (the site and widget editors), which is why it is checked before use.
add_filter('allowed_block_types_all', function ($allowed_block_types, $block_editor_context) {
    if (isset($block_editor_context->post) && $block_editor_context->post->post_type === 'jamground_author') {
        return [];
    }
    return [
        'core/paragraph',
        'core/heading',
        'core/list',
        'core/list-item',
        'core/quote',
        'core/code',
        'core/table',
        'core/separator',
    ];
}, 10, 2);

// 2. Strip supports the contract cannot express, before registration — so the controls
// never appear, rather than appearing and being refused at save time.
add_filter('register_block_type_args', function ($args) {
    $args['supports'] = array_merge($args['supports'] ?? [], [
        'color' => false,
        'typography' => false,
        'spacing' => false,
        'border' => false,
        'shadow' => false,
        'className' => false,
        'customClassName' => false,
        'anchor' => false,
        'align' => false,
        'dimensions' => false,
        'position' => false,
        'layout' => false,
        'filter' => false,
    ]);
    return $args;
}, 10, 1);

// 3. The shared block stylesheet. Registered
// with a false source and enqueued on enqueue_block_assets so it loads inside the editor
// canvas as well as the front end preview; a custom property is set so a test can observe
// that this hook actually ran.
add_action('init', function () {
    wp_register_style('jamground-blocks', false);
    wp_add_inline_style('jamground-blocks', 'body{--jp-mu-plugin:present;}');
});
add_action('enqueue_block_assets', function () {
    wp_enqueue_style('jamground-blocks');
});

// 4. Suppress the welcome guide. An editor whose familiarity is the product should not
// be met by WordPress's own onboarding modal.
add_action('admin_init', function () {
    update_user_meta(get_current_user_id(), 'wp_persisted_preferences', [
        'core/edit-post' => ['welcomeGuide' => false],
        'core' => ['welcomeGuide' => false],
    ]);
});

// 5. The admin menu: only the three kinds this product can round-trip.
//
// What is left is exactly `WP_POST_TYPES` in editor/lib/kinds.mjs — Posts, Pages, Authors.
// Everything removed below is a WordPress affordance that cannot be honoured here: an
// editor who follows one either changes nothing, or changes something that is thrown away
// on the next reload. Both read as a defect, and there is no way to tell them apart from
// the inside.
//
// `remove_menu_page()` HIDES THE ENTRY, NOT THE SCREEN, and that is deliberate rather than a
// limitation worked around: `edit.php` and `post.php` stay reachable by URL, which is how the
// Playwright suite navigates (import.test.mjs, draft.test.mjs, mu-plugin.test.mjs all call
// `client.goTo` with an explicit admin URL). Anything stronger — `show_ui => false`, a
// capability check, a `load-*` redirect — would take the menu and those tests together.
add_action('admin_menu', function () {
    remove_menu_page('index.php');            // Dashboard, and the Updates submenu under it
    remove_menu_page('upload.php');           // Media — import.mjs has no media path yet
    remove_menu_page('edit-comments.php');    // Comments — deleted at boot; no contract field
    remove_menu_page('themes.php');           // Appearance — Astro renders the site, not this
    remove_menu_page('plugins.php');          // Plugins — a fresh database every boot
    remove_menu_page('users.php');            // Users — single-user auto-login; an author is a ULID
    remove_menu_page('tools.php');            // Tools — import/export/health mean nothing in WASM
    remove_menu_page('options-general.php');  // Settings — permalinks and reading are all inert
});

// 6. The admin bar: remove the nodes that lead out of the product.
//
// `site-name` is deliberately absent from this list. It is a link to the site, so section 12
// owns it — it gets a real address rather than being taken away.
//
// PRIORITY 99999, AND THE NUMBER IS LOAD-BEARING. Most of WordPress's nodes are added between
// 0 and 200, but `wp_admin_bar_my_account_item` is hooked at 9999 so the avatar renders last on
// the right — so a removal at any lower priority takes the node created at 0 and then watches
// 9999 put it back. Observed exactly that way: every other node here disappeared and
// "Howdy, admin" did not.
//
// `menu-toggle` is deliberately kept: it is the responsive sidebar control, which is real UI
// rather than a claim about WordPress.
add_action('admin_bar_menu', function ($bar) {
    $bar->remove_node('wp-logo');          // About WordPress, the docs, the support forums, feedback
    $bar->remove_node('comments');         // A moderation queue over comments that cannot exist
    $bar->remove_node('new-content');      // "+ New" offers media and users among its targets
    $bar->remove_node('command-palette');  // Its results reach the screens section 5 just removed
    $bar->remove_node('my-account');       // "Howdy, admin" — profile and log-out of an ephemeral instance
}, 99999);

// 7. The dashboard an editor lands on.
//
// The blueprint's `landingPage` is `/wp-admin/`, so this is the first screen of the product,
// and every widget on it by default reports on a database that is deleted on the next reload:
// a post count, an activity feed, a site-health check, and a Quick Draft whose Save Draft
// button writes somewhere no save path ever reads. The news feed and the welcome panel are
// WordPress marketing. None of it is false; all of it is about the wrong thing.
//
// Section 5 removes the Dashboard's own menu entry, so nothing navigates BACK here — this
// screen is only ever the one an editor arrives on.
add_action('wp_dashboard_setup', function () {
    remove_action('welcome_panel', 'wp_welcome_panel');               // "Welcome to WordPress!"
    remove_meta_box('dashboard_primary',     'dashboard', 'side');    // WordPress Events and News
    remove_meta_box('dashboard_quick_press', 'dashboard', 'side');    // Quick Draft — writes nowhere
    remove_meta_box('dashboard_right_now',   'dashboard', 'normal');  // At a Glance
    remove_meta_box('dashboard_activity',    'dashboard', 'normal');  // Activity
    remove_meta_box('dashboard_site_health', 'dashboard', 'normal');  // Site Health Status
    remove_meta_box('dashboard_php_nag',     'dashboard', 'normal');
    remove_meta_box('dashboard_browser_nag', 'dashboard', 'normal');
});

// 8. Update nags and the version chrome.
//
// This instance is rebuilt from WordPress's own image on every boot. There is nothing here an
// editor could update, and nothing that would survive being updated if they did — so an
// upgrade notice is an instruction that cannot be carried out, and the footer's "Version 7.1"
// names a number about the editing tool that is not a fact about the site.
add_action('admin_init', function () {
    remove_action('admin_notices', 'update_nag', 3);
    remove_action('network_admin_notices', 'update_nag', 3);
});
add_filter('site_transient_update_core',    '__return_null');
add_filter('site_transient_update_plugins', '__return_null');
add_filter('site_transient_update_themes',  '__return_null');
add_filter('admin_footer_text', '__return_empty_string');      // "Thank you for creating with WordPress."
add_filter('update_footer',     '__return_empty_string', 11);  // "Version 7.1"

// 9. The help tabs.
//
// Every tab's content is links to wordpress.org documentation about administering a WordPress
// nobody administers. Removing the tabs removes the Help button with them. SCREEN OPTIONS
// STAYS: on `edit.php` it controls columns and pagination, which are real.
add_action('admin_head', function () {
    $screen = get_current_screen();
    if ($screen) {
        $screen->remove_help_tabs();
    }
});

// 10. The inline-format allowlist — this file's only JavaScript, and it has to be.
//
// Section 1 restricts BLOCKS and section 2 strips their supports, but neither touches the
// rich-text formats inside a paragraph, and there is no PHP filter that does: formats are
// registered in JS, so they can only be unregistered there.
//
// The contract allows exactly four marks — bold, italic, inline code, link
// (ALLOWED_INLINE_NODE_TYPES in src/contract/defs.ts, and the tag-level allowlist in
// editor/lib/html-to-inline.mjs). Everything else in the toolbar throws
// "Prohibited mark inside InlineText" at SAVE time, which is the same defect section 2 exists
// to avoid one level up: a control that produces work that cannot be written. So the controls
// go, and the four that remain are the four that round-trip.
//
// `wp-format-library` is the handle that registers the removable formats, so an inline script
// on it runs after them. The names are guarded individually because which ones exist is a
// WordPress-version fact, and a name that was never registered must not take the rest with it.
add_action('enqueue_block_editor_assets', function () {
    wp_add_inline_script('wp-format-library', <<<'JS'
( function () {
    var run = function () {
        [
            'core/strikethrough',
            'core/superscript',
            'core/subscript',
            'core/text-color',
            'core/image',
            'core/keyboard',
            'core/language',
            'core/footnotes'
        ].forEach( function ( name ) {
            try {
                wp.richText.unregisterFormatType( name );
            } catch ( e ) {}
        } );
    };
    if ( window.wp && wp.domReady ) {
        wp.domReady( run );
    } else {
        window.addEventListener( 'load', run );
    }
} )();
JS
    );
});

// 11. The panels and taxonomies nothing reads back.
//
// editor/lib/read-posts.mjs reads THREE WordPress fields — `post_title`, `post_name`,
// `post_content` — plus the four `_jamground_*` metas import.mjs wrote. Every control below
// is therefore one an editor can operate whose value cannot reach a save: an excerpt, a
// featured image, a discussion setting, a page template, a revision, a category.
//
// `Post.tags` is NOT lost by unregistering the taxonomy. Tags never became WordPress terms in
// the first place — nothing anywhere calls `register_taxonomy` or `wp_set_post_terms` — and
// export.mjs re-emits them from the stored baseline untouched. What goes is a panel that was
// already inert.
//
// STATUS AND VISIBILITY STAY. They carry something real: import.mjs sets `post_status` from
// the contract's own `status`, so draft-versus-published in wp-admin is true information about
// the entity. That an EDIT to it does not travel is a genuine gap, and hiding the panel would
// conceal the gap rather than close it.
//
// Priority 11, after core has registered the types and taxonomies this unregisters from.
add_action('init', function () {
    foreach (['post', 'page'] as $type) {
        remove_post_type_support($type, 'excerpt');
        remove_post_type_support($type, 'comments');
        remove_post_type_support($type, 'trackbacks');
        remove_post_type_support($type, 'custom-fields');
        remove_post_type_support($type, 'thumbnail');
        remove_post_type_support($type, 'revisions');
        remove_post_type_support($type, 'post-formats');
    }
    remove_post_type_support('page', 'page-attributes');  // template, parent, menu order
    unregister_taxonomy_for_object_type('category', 'post');
    unregister_taxonomy_for_object_type('post_tag', 'post');
}, 11);

// 12. Site links point at the site.
//
// WordPress resolves "View Page", "Preview" and the admin bar's site name through
// `home_url()`, which here is the Playground scoped origin with plain `?p=` permalinks. Every
// one of them opens this WASM instance's own theme rendering — an address that is not the
// site, showing markup the site does not serve. Nothing filtered them before this section.
//
// THE REAL ADDRESS IS NOT COMPUTED HERE, AND MUST NOT BE. src/lib/links.ts holds the routing
// table exactly once ("Every href in src/ goes through them … so the table has exactly one
// home"), so the shell calls those helpers and hands the results over as a JSON data file —
// the same discipline read-posts.mjs states for the post-type list: nothing composes PHP
// around a value, ever. This section does a lookup and no arithmetic.
//
// A post with NO ENTRY has no honest address, and gets no link rather than a guessed one.
// That is not an edge case, it is the two real ones: a draft while no change is open (the
// production build excludes drafts, so it is nowhere), and an entity created in this session
// (which no save has written yet).
//
// ABSPATH, not `__DIR__`: read-posts.mjs can use `__DIR__` because its PHP is written into the
// document root, and this file is two levels down at wp-content/mu-plugins/.
//
// `static` so a list table of thirty rows reads the file once. PHP here is per-request, so a
// rewrite from the shell is picked up on the next page load — a screen already open keeps the
// addresses it rendered with, which matters once: an editor sitting on a post when a change
// opens keeps the production link until they navigate.
function jamground_site_links() {
    static $conf = null;
    if ($conf === null) {
        $path = ABSPATH . 'jp-site-links.json';
        $decoded = file_exists($path) ? json_decode(file_get_contents($path), true) : null;
        $conf = is_array($decoded) ? $decoded : [];
    }
    return $conf;
}

function jamground_site_url_for($post_id) {
    $conf = jamground_site_links();
    $key = (string) $post_id;
    if (empty($conf['origin']) || !isset($conf['byPostId'][$key])) {
        return null;
    }
    return rtrim($conf['origin'], '/') . $conf['byPostId'][$key];
}

function jamground_site_home_url() {
    $conf = jamground_site_links();
    if (empty($conf['origin']) || empty($conf['homePath'])) {
        return null;
    }
    return rtrim($conf['origin'], '/') . $conf['homePath'];
}

// `post_link` and `post_type_link` are handed the post OBJECT; `page_link` is handed an ID.
// Rewriting the permalink also fixes the block editor's "View Page": REST's `link` field comes
// from `get_permalink()`, which runs these.
add_filter('post_link', function ($url, $post) {
    $real = jamground_site_url_for(is_object($post) ? $post->ID : $post);
    return $real === null ? $url : $real;
}, 10, 2);

add_filter('page_link', function ($url, $post_id) {
    $real = jamground_site_url_for($post_id);
    return $real === null ? $url : $real;
}, 10, 2);

add_filter('post_type_link', function ($url, $post) {
    $real = jamground_site_url_for(is_object($post) ? $post->ID : $post);
    return $real === null ? $url : $real;
}, 10, 2);

// Preview is the one link whose WORD this cannot honour, and it is worth being exact about
// why. WordPress's Preview means "see your unsaved draft": the shell cannot know about unsaved
// edits at all — it cannot reach Gutenberg's DOM across the Playground origin boundary — and
// the staging site is rebuilt from the save, not from typing. So this address shows the last
// SAVED state. It is pointed at the same real place as the permalink because that is the
// closest true thing, and the shell's status line is where the caveat is said in words.
// With nothing to show, it returns empty rather than a WASM address dressed up as the site.
add_filter('preview_post_link', function ($url, $post) {
    $real = jamground_site_url_for(is_object($post) ? $post->ID : $post);
    return $real === null ? '' : $real;
}, 10, 2);

// The admin bar's site name and its "Visit Site" child. Removed outright when there is no
// address, for the same reason as above.
add_action('admin_bar_menu', function ($bar) {
    if (!$bar->get_node('site-name')) {
        return;
    }
    $home = jamground_site_home_url();
    if ($home === null) {
        $bar->remove_node('site-name');
        return;
    }
    $bar->add_node(['id' => 'site-name', 'href' => $home]);
    if ($bar->get_node('view-site')) {
        $bar->add_node(['id' => 'view-site', 'href' => $home]);
    }
    $bar->remove_node('dashboard');  // "Dashboard", whose menu entry section 5 removed
}, 100000);  // after section 6, for the reason given there
