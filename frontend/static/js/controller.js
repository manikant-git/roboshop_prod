/*
 * Stan's Robot Shop - frontend application
 *
 * Adds to the original AngularJS app:
 *  - JWT authentication (access + refresh tokens) with session persistence,
 *    "remember me", auto login on load and auto logout on expiry
 *  - an $http interceptor that attaches the bearer token, refreshes expired
 *    access tokens once, and drives the global loading indicator
 *  - route guards for the authenticated pages
 *  - toast notifications and per-action loading states
 */
(function(angular) {
    'use strict';

    var API = {
        catalogue: '/api/catalogue',
        user: '/api/user',
        cart: '/api/cart',
        shipping: '/api/shipping',
        payment: '/api/payment',
        ratings: '/api/ratings'
    };

    var robotshop = angular.module('robotshop', ['ngRoute']);

    /* ------------------------------------------------------------------ *
     * Toast notifications
     * ------------------------------------------------------------------ */
    robotshop.factory('toast', ['$rootScope', '$timeout', function($rootScope, $timeout) {
        $rootScope.toasts = [];

        function push(text, type) {
            var t = { text: text, type: type || 'info' };
            $rootScope.toasts.push(t);
            $timeout(function() {
                var i = $rootScope.toasts.indexOf(t);
                if (i > -1) {
                    $rootScope.toasts.splice(i, 1);
                }
            }, 4500);
        }

        return {
            success: function(m) { push(m, 'success'); },
            error: function(m) { push(m, 'error'); },
            info: function(m) { push(m, 'info'); }
        };
    }]);

    /* ------------------------------------------------------------------ *
     * Global loading indicator
     * ------------------------------------------------------------------ */
    robotshop.factory('loading', ['$rootScope', function($rootScope) {
        $rootScope.loading = { active: false };
        var count = 0;
        return {
            start: function() { count++; $rootScope.loading.active = true; },
            stop: function() { count = Math.max(0, count - 1); $rootScope.loading.active = count > 0; }
        };
    }]);

    /* ------------------------------------------------------------------ *
     * Error message extraction
     * ------------------------------------------------------------------ */
    robotshop.factory('apiError', function() {
        return function(res, fallback) {
            if (res && res.data) {
                if (typeof res.data === 'string' && res.data.trim()) return res.data;
                if (res.data.error) return res.data.error;
            }
            if (res && res.status === -1) return 'Cannot reach the server';
            return fallback || 'Something went wrong';
        };
    });

    /* ------------------------------------------------------------------ *
     * Authentication service
     * ------------------------------------------------------------------ */
    robotshop.factory('auth', ['$http', '$q', '$rootScope', '$timeout',
        function($http, $q, $rootScope, $timeout) {
            var KEY = 'roboshop.auth';
            var state = { user: null, accessToken: null, refreshToken: null, remember: false };
            var logoutTimer = null;

            function store() {
                return state.remember ? window.localStorage : window.sessionStorage;
            }

            function persist() {
                var payload = JSON.stringify({
                    user: state.user,
                    accessToken: state.accessToken,
                    refreshToken: state.refreshToken,
                    remember: state.remember
                });
                try {
                    clearStorage();
                    store().setItem(KEY, payload);
                } catch (e) {
                    // storage unavailable (private mode) - session stays in memory
                }
            }

            function clearStorage() {
                try {
                    window.localStorage.removeItem(KEY);
                    window.sessionStorage.removeItem(KEY);
                } catch (e) { /* ignore */ }
            }

            function decode(token) {
                try {
                    var part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
                    return JSON.parse(window.atob(part));
                } catch (e) {
                    return null;
                }
            }

            function expiryMs(token) {
                var claims = decode(token);
                return claims && claims.exp ? claims.exp * 1000 : 0;
            }

            /* Schedules an automatic refresh shortly before the access token
             * expires, and a hard logout if the refresh is not possible. */
            function scheduleAutoLogout() {
                if (logoutTimer) {
                    $timeout.cancel(logoutTimer);
                    logoutTimer = null;
                }
                if (!state.accessToken) return;
                var lead = 30000;
                var delay = expiryMs(state.accessToken) - Date.now() - lead;
                if (delay < 0) delay = 0;
                logoutTimer = $timeout(function() {
                    api.refresh().catch(function() {
                        api.logout(true);
                    });
                }, delay, false);
            }

            function apply(session, remember) {
                state.user = session.user || state.user;
                state.accessToken = session.accessToken || state.accessToken;
                if (session.refreshToken) state.refreshToken = session.refreshToken;
                if (typeof remember === 'boolean') state.remember = remember;
                persist();
                scheduleAutoLogout();
                $rootScope.$broadcast('auth:changed', state.user);
            }

            var api = {
                init: function() {
                    var raw = null;
                    try {
                        raw = window.localStorage.getItem(KEY) || window.sessionStorage.getItem(KEY);
                    } catch (e) { raw = null; }
                    if (!raw) return;
                    var saved;
                    try { saved = JSON.parse(raw); } catch (e) { clearStorage(); return; }
                    if (!saved || !saved.refreshToken) { clearStorage(); return; }

                    state.user = saved.user;
                    state.accessToken = saved.accessToken;
                    state.refreshToken = saved.refreshToken;
                    state.remember = !!saved.remember;

                    // Auto login: if the refresh token is still valid, silently
                    // mint a fresh access token, otherwise drop the session.
                    if (expiryMs(state.refreshToken) <= Date.now()) {
                        api.logout(true);
                        return;
                    }
                    if (expiryMs(state.accessToken) <= Date.now() + 5000) {
                        api.refresh().catch(function() { api.logout(true); });
                    } else {
                        scheduleAutoLogout();
                        $rootScope.$broadcast('auth:changed', state.user);
                    }
                },

                user: function() { return state.user; },
                token: function() { return state.accessToken; },
                isAuthenticated: function() {
                    return !!state.accessToken && expiryMs(state.accessToken) > Date.now();
                },
                hasRole: function(role) {
                    return !!state.user && state.user.role === role;
                },

                login: function(credentials) {
                    return $http.post(API.user + '/login', {
                        email: credentials.email,
                        password: credentials.password,
                        remember: !!credentials.remember
                    }).then(function(res) {
                        apply(res.data, !!credentials.remember);
                        return res.data.user;
                    });
                },

                register: function(payload) {
                    return $http.post(API.user + '/register', payload).then(function(res) {
                        apply(res.data, false);
                        return res.data.user;
                    });
                },

                refresh: function() {
                    if (!state.refreshToken) return $q.reject('no refresh token');
                    return $http.post(API.user + '/refresh', { refreshToken: state.refreshToken }, {
                        skipAuth: true,
                        skipLoader: true
                    }).then(function(res) {
                        apply({ user: res.data.user, accessToken: res.data.accessToken });
                        return res.data.accessToken;
                    });
                },

                /* Clears the JWT, the in-memory session and both web storages. */
                logout: function(silent) {
                    var hadToken = !!state.accessToken;
                    var done = hadToken
                        ? $http.post(API.user + '/logout', {}, { skipLoader: true }).catch(function() { return null; })
                        : $q.when(null);

                    return done.finally(function() {
                        state.user = null;
                        state.accessToken = null;
                        state.refreshToken = null;
                        state.remember = false;
                        clearStorage();
                        if (logoutTimer) { $timeout.cancel(logoutTimer); logoutTimer = null; }
                        $rootScope.$broadcast('auth:changed', null);
                        if (!silent) {
                            $rootScope.$broadcast('auth:loggedout');
                        } else {
                            $rootScope.$broadcast('auth:expired');
                        }
                    });
                },

                updateUser: function(user) {
                    state.user = user;
                    persist();
                    $rootScope.$broadcast('auth:changed', user);
                }
            };

            return api;
        }
    ]);

    /* ------------------------------------------------------------------ *
     * HTTP interceptor: bearer token, loader, 401 refresh-and-retry
     * ------------------------------------------------------------------ */
    robotshop.factory('httpInterceptor', ['$q', '$injector', 'loading',
        function($q, $injector, loading) {
            var refreshing = null;

            return {
                request: function(config) {
                    if (!config.skipLoader) {
                        config.__loader = true;
                        loading.start();
                    }
                    if (!config.skipAuth && config.url && config.url.indexOf('/api/') === 0) {
                        var auth = $injector.get('auth');
                        var token = auth.token();
                        if (token) {
                            config.headers = config.headers || {};
                            config.headers.Authorization = 'Bearer ' + token;
                        }
                    }
                    return config;
                },
                response: function(response) {
                    if (response.config && response.config.__loader) loading.stop();
                    return response;
                },
                responseError: function(rejection) {
                    if (rejection.config && rejection.config.__loader) loading.stop();

                    var auth = $injector.get('auth');
                    var config = rejection.config || {};
                    var retryable = rejection.status === 401 &&
                        !config.__retried &&
                        !config.skipAuth &&
                        config.url &&
                        config.url.indexOf(API.user + '/login') !== 0 &&
                        config.url.indexOf(API.user + '/refresh') !== 0;

                    if (retryable && auth.token()) {
                        if (!refreshing) {
                            refreshing = auth.refresh().finally(function() { refreshing = null; });
                        }
                        return refreshing.then(function() {
                            config.__retried = true;
                            return $injector.get('$http')(config);
                        }).catch(function() {
                            auth.logout(true);
                            return $q.reject(rejection);
                        });
                    }

                    return $q.reject(rejection);
                }
            };
        }
    ]);

    robotshop.config(['$httpProvider', function($httpProvider) {
        $httpProvider.interceptors.push('httpInterceptor');
    }]);

    /* ------------------------------------------------------------------ *
     * Routing
     * ------------------------------------------------------------------ */
    robotshop.config(['$routeProvider', '$locationProvider', '$compileProvider',
        function($routeProvider, $locationProvider, $compileProvider) {
            $compileProvider.debugInfoEnabled(false);

            function guarded() {
                return {
                    session: ['auth', '$q', '$location', function(auth, $q, $location) {
                        if (auth.isAuthenticated() || auth.user()) {
                            return true;
                        }
                        $location.url('/login');
                        return $q.reject('unauthenticated');
                    }]
                };
            }

            $routeProvider
                .when('/', { templateUrl: '/splash.html', controller: 'homeform' })
                .when('/products', { templateUrl: '/products.html', controller: 'productsform' })
                .when('/search/:text', { templateUrl: '/search.html', controller: 'searchform' })
                .when('/product/:sku', { templateUrl: '/product.html', controller: 'productform' })
                .when('/cart', { templateUrl: '/cart.html', controller: 'cartform' })
                .when('/shipping', { templateUrl: '/shipping.html', controller: 'shipform' })
                .when('/payment', { templateUrl: '/payment.html', controller: 'paymentform' })
                .when('/login', { templateUrl: '/login.html', controller: 'loginform' })
                .when('/register', { templateUrl: '/register.html', controller: 'registerform' })
                .when('/forgot-password', { templateUrl: '/forgot.html', controller: 'forgotform' })
                .when('/reset-password', { templateUrl: '/reset.html', controller: 'resetform' })
                .when('/profile', { templateUrl: '/profile.html', controller: 'profileform', resolve: guarded() })
                .when('/orders', { templateUrl: '/orders.html', controller: 'ordersform', resolve: guarded() })
                .otherwise({ redirectTo: '/' });

            $locationProvider.html5Mode(true);
        }
    ]);

    robotshop.run(['$rootScope', 'auth', function($rootScope, auth) {
        auth.init();

        // Instana EUM page tracking (optional)
        $rootScope.$on('$routeChangeSuccess', function(event, next) {
            if (typeof ineum !== 'undefined' && next && next.loadedTemplateUrl) {
                ineum('page', next.loadedTemplateUrl);
            }
        });
    }]);

    /* ------------------------------------------------------------------ *
     * Shared session state (cart identity)
     * ------------------------------------------------------------------ */
    robotshop.factory('currentUser', function() {
        return {
            uniqueid: '',
            user: {},
            cart: { total: 0, tax: 0, items: [] }
        };
    });

    /* ------------------------------------------------------------------ *
     * Shell controller - navbar, categories, cart badge
     * ------------------------------------------------------------------ */
    robotshop.controller('shopform', ['$scope', '$http', '$location', '$rootScope', 'currentUser', 'auth', 'toast', 'apiError',
        function($scope, $http, $location, $rootScope, currentUser, auth, toast, apiError) {
            $scope.data = {
                uniqueid: '',
                categories: [],
                products: {},
                searchText: '',
                navOpen: false,
                cart: currentUser.cart,
                user: auth.user()
            };

            $scope.toggleNav = function() { $scope.data.navOpen = !$scope.data.navOpen; };
            $scope.closeNav = function() { $scope.data.navOpen = false; };

            $scope.getProducts = function(category) {
                if ($scope.data.products[category]) {
                    $scope.data.products[category] = null;
                    return;
                }
                $http.get(API.catalogue + '/products/' + encodeURIComponent(category), { skipLoader: true })
                    .then(function(res) { $scope.data.products[category] = res.data; })
                    .catch(function(e) { toast.error(apiError(e, 'Could not load ' + category)); });
            };

            $scope.search = function() {
                var text = ($scope.data.searchText || '').trim();
                if (text) {
                    $location.url('/search/' + encodeURIComponent(text));
                    $scope.data.searchText = '';
                    $scope.closeNav();
                }
            };

            $scope.logout = function() {
                auth.logout().then(function() {
                    $scope.closeNav();
                    toast.success('You have been signed out');
                    $location.url('/');
                });
            };

            function loadCategories() {
                $http.get(API.catalogue + '/categories', { skipLoader: true })
                    .then(function(res) { $scope.data.categories = res.data; })
                    .catch(function(e) { toast.error(apiError(e, 'Could not load categories')); });
            }

            function assignCartId() {
                var user = auth.user();
                if (user) {
                    currentUser.uniqueid = user.name;
                    $scope.data.uniqueid = user.name;
                    return;
                }
                $http.get(API.user + '/uniqueid', { skipLoader: true }).then(function(res) {
                    currentUser.uniqueid = res.data.uuid;
                    $scope.data.uniqueid = res.data.uuid;
                    if (typeof ineum !== 'undefined') {
                        ineum('user', res.data.uuid);
                    }
                }).catch(function() {
                    // fall back to a client generated id so the shop still works
                    var id = 'anonymous-' + Math.random().toString(36).slice(2, 10);
                    currentUser.uniqueid = id;
                    $scope.data.uniqueid = id;
                });
            }

            function loadCart() {
                if (!currentUser.uniqueid) return;
                $http.get(API.cart + '/cart/' + encodeURIComponent(currentUser.uniqueid), { skipLoader: true })
                    .then(function(res) {
                        angular.copy(res.data, currentUser.cart);
                        $scope.data.cart = currentUser.cart;
                    })
                    .catch(function() { /* 404 simply means no cart yet */ });
            }

            $rootScope.$on('auth:changed', function(event, user) {
                $scope.data.user = user;
                if (user) {
                    currentUser.user = user;
                    currentUser.uniqueid = user.name;
                    $scope.data.uniqueid = user.name;
                    if (typeof ineum !== 'undefined') {
                        ineum('user', user.name, user.name, user.email);
                    }
                    loadCart();
                } else {
                    currentUser.user = {};
                    angular.copy({ total: 0, tax: 0, items: [] }, currentUser.cart);
                    assignCartId();
                }
            });

            $rootScope.$on('auth:expired', function() {
                toast.info('Your session expired, please sign in again');
                $location.url('/login');
            });

            $scope.$watch(function() { return currentUser.cart.total; }, function() {
                $scope.data.cart = currentUser.cart;
            });

            $scope.$watch(function() { return currentUser.uniqueid; }, function(v) {
                if (v) $scope.data.uniqueid = v;
            });

            loadCategories();
            assignCartId();
            if (auth.user()) {
                loadCart();
            }
        }
    ]);

    /* ------------------------------------------------------------------ *
     * Cart helper shared by the product pages
     * ------------------------------------------------------------------ */
    robotshop.factory('cartService', ['$http', 'currentUser', function($http, currentUser) {
        return {
            add: function(sku, qty) {
                var url = API.cart + '/add/' + encodeURIComponent(currentUser.uniqueid) + '/' +
                    encodeURIComponent(sku) + '/' + encodeURIComponent(qty);
                return $http.get(url, { skipLoader: true }).then(function(res) {
                    angular.copy(res.data, currentUser.cart);
                    return res.data;
                });
            }
        };
    }]);

    /* ------------------------------------------------------------------ *
     * Page controllers
     * ------------------------------------------------------------------ */

    robotshop.controller('homeform', ['$scope', 'auth', function($scope, auth) {
        $scope.data = { user: auth.user() };
    }]);

    robotshop.controller('productsform', ['$scope', '$http', 'cartService', 'toast', 'apiError',
        function($scope, $http, cartService, toast, apiError) {
            $scope.data = { products: [], loading: true, adding: null };

            $scope.addToCart = function(prod) {
                $scope.data.adding = prod.sku;
                cartService.add(prod.sku, 1).then(function() {
                    toast.success(prod.name + ' added to your cart');
                }).catch(function(e) {
                    toast.error(apiError(e, 'Could not add that item'));
                }).finally(function() {
                    $scope.data.adding = null;
                });
            };

            $http.get(API.catalogue + '/products', { skipLoader: true }).then(function(res) {
                $scope.data.products = res.data;
            }).catch(function(e) {
                toast.error(apiError(e, 'Could not load the catalogue'));
            }).finally(function() {
                $scope.data.loading = false;
            });
        }
    ]);

    robotshop.controller('searchform', ['$scope', '$http', '$routeParams', 'toast', 'apiError',
        function($scope, $http, $routeParams, toast, apiError) {
            $scope.data = { searchResults: [], loading: true, term: $routeParams.text };

            $http.get(API.catalogue + '/search/' + encodeURIComponent($routeParams.text), { skipLoader: true })
                .then(function(res) { $scope.data.searchResults = res.data; })
                .catch(function(e) { toast.error(apiError(e, 'Search failed')); })
                .finally(function() { $scope.data.loading = false; });
        }
    ]);

    robotshop.controller('productform', ['$scope', '$http', '$routeParams', 'cartService', 'toast', 'apiError',
        function($scope, $http, $routeParams, cartService, toast, apiError) {
            $scope.data = {
                product: {},
                rating: { avg_rating: 0, rating_count: 0 },
                quantity: 1,
                busy: false
            };

            $scope.addToCart = function() {
                $scope.data.busy = true;
                cartService.add($scope.data.product.sku, $scope.data.quantity).then(function() {
                    toast.success('Added to your cart');
                }).catch(function(e) {
                    toast.error(apiError(e, 'Could not add that item'));
                }).finally(function() {
                    $scope.data.busy = false;
                });
            };

            $scope.rateProduct = function(score) {
                $http.put(API.ratings + '/api/rate/' + encodeURIComponent($scope.data.product.sku) + '/' + score, {}, { skipLoader: true })
                    .then(function() {
                        toast.success('Thank you for your feedback');
                        loadRating($scope.data.product.sku);
                    })
                    .catch(function() { toast.error('Ratings are not available right now'); });
            };

            $scope.glowstan = function(vote, val) {
                var idx = vote;
                while (idx > 0) {
                    var el = document.getElementById('vote-' + idx);
                    if (el) el.style.opacity = val;
                    idx--;
                }
            };

            function loadRating(sku) {
                $http.get(API.ratings + '/api/fetch/' + encodeURIComponent(sku), { skipLoader: true })
                    .then(function(res) { $scope.data.rating = res.data; })
                    .catch(function() { /* ratings service is optional */ });
            }

            $http.get(API.catalogue + '/product/' + encodeURIComponent($routeParams.sku), { skipLoader: true })
                .then(function(res) { $scope.data.product = res.data; })
                .catch(function(e) { toast.error(apiError(e, 'Could not load that product')); });
            loadRating($routeParams.sku);
        }
    ]);

    robotshop.controller('cartform', ['$scope', '$http', '$location', 'currentUser', 'toast', 'apiError',
        function($scope, $http, $location, currentUser, toast, apiError) {
            $scope.data = {
                cart: { total: 0, tax: 0, items: [] },
                uniqueid: currentUser.uniqueid,
                loading: true
            };

            $scope.buy = function() { $location.url('/shipping'); };

            $scope.change = function(sku, qty) {
                var url = API.cart + '/update/' + encodeURIComponent($scope.data.uniqueid) + '/' +
                    encodeURIComponent(sku) + '/' + encodeURIComponent(qty);
                $http.get(url, { skipLoader: true }).then(function(res) {
                    $scope.data.cart = res.data;
                    angular.copy(res.data, currentUser.cart);
                    if (parseInt(qty, 10) === 0) toast.info('Item removed');
                }).catch(function(e) {
                    toast.error(apiError(e, 'Could not update your cart'));
                });
            };

            function loadCart(id) {
                if (!id) {
                    $scope.data.loading = false;
                    return;
                }
                $http.get(API.cart + '/cart/' + encodeURIComponent(id), { skipLoader: true }).then(function(res) {
                    var cart = res.data;
                    var items = cart.items || [];
                    // drop any stale shipping line so it is recalculated at checkout
                    if (items.length && items[items.length - 1].sku === 'SHIP') {
                        return $http.get(API.cart + '/update/' + encodeURIComponent(id) + '/SHIP/0', { skipLoader: true })
                            .then(function(r) {
                                $scope.data.cart = r.data;
                                angular.copy(r.data, currentUser.cart);
                            });
                    }
                    $scope.data.cart = cart;
                    angular.copy(cart, currentUser.cart);
                }).catch(function() {
                    $scope.data.cart = { total: 0, tax: 0, items: [] };
                }).finally(function() {
                    $scope.data.loading = false;
                });
            }

            $scope.$watch(function() { return currentUser.uniqueid; }, function(id) {
                if (id && id !== $scope.data.uniqueid) {
                    $scope.data.uniqueid = id;
                }
                if (id) loadCart(id);
            });

            loadCart($scope.data.uniqueid);
        }
    ]);

    robotshop.controller('shipform', ['$scope', '$http', '$location', 'currentUser', 'toast', 'apiError',
        function($scope, $http, $location, currentUser, toast, apiError) {
            $scope.data = {
                countries: [],
                selectedCountry: '',
                selectedLocation: '',
                disableCity: true,
                disableCalc: true,
                shipping: '',
                busy: false,
                confirming: false
            };

            var autoLocation;
            var uuid;

            $scope.calcShipping = function() {
                if (!uuid) return;
                $scope.data.busy = true;
                $http.get(API.shipping + '/calc/' + encodeURIComponent(uuid), { skipLoader: true }).then(function(res) {
                    $scope.data.shipping = res.data;
                    $scope.data.shipping.location = $scope.data.selectedCountry.name + ' ' + autoLocation;
                }).catch(function(e) {
                    toast.error(apiError(e, 'Could not calculate shipping'));
                }).finally(function() {
                    $scope.data.busy = false;
                });
            };

            $scope.confirmShipping = function() {
                $scope.data.confirming = true;
                $http.post(API.shipping + '/confirm/' + encodeURIComponent(currentUser.uniqueid), $scope.data.shipping, { skipLoader: true })
                    .then(function(res) {
                        angular.copy(res.data, currentUser.cart);
                        $location.url('/payment');
                    })
                    .catch(function(e) {
                        toast.error(apiError(e, 'Could not confirm shipping'));
                    })
                    .finally(function() { $scope.data.confirming = false; });
            };

            $scope.countryChanged = function() {
                if ($scope.data.selectedCountry) {
                    $scope.data.disableCity = false;
                }
                $scope.data.selectedLocation = '';
                $scope.data.disableCalc = true;
                $scope.data.shipping = '';
            };

            function loadCodes() {
                $http.get(API.shipping + '/codes', { skipLoader: true })
                    .then(function(res) { $scope.data.countries = res.data; })
                    .catch(function(e) { toast.error(apiError(e, 'Could not load countries')); });
            }

            function buildauto() {
                autoLocation = new autoComplete({
                    selector: 'input[id=location]',
                    source: function(term, suggest) {
                        $scope.data.disableCalc = true;
                        if (!$scope.data.selectedCountry) return;
                        $http.get(API.shipping + '/match/' + encodeURIComponent($scope.data.selectedCountry.code) +
                            '/' + encodeURIComponent(term), { skipLoader: true })
                            .then(function(res) { suggest(res.data); })
                            .catch(function() { suggest([]); });
                    },
                    renderItem: function(item) {
                        return '<div class="autocomplete-suggestion" loc-uuid="' + item.uuid +
                            '" data-val="' + item.name + '">' + item.name + '</div>';
                    },
                    onSelect: function(e, term, item) {
                        uuid = item.getAttribute('loc-uuid');
                        autoLocation = item.getAttribute('data-val');
                        $scope.data.disableCalc = false;
                        $scope.data.shipping = '';
                        $scope.$apply();
                    }
                });
            }

            loadCodes();
            buildauto();
        }
    ]);

    robotshop.controller('paymentform', ['$scope', '$http', 'currentUser', 'toast', 'apiError',
        function($scope, $http, currentUser, toast, apiError) {
            $scope.data = {
                message: '',
                buttonDisabled: false,
                cont: false,
                uniqueid: currentUser.uniqueid,
                cart: currentUser.cart
            };

            $scope.pay = function() {
                $scope.data.buttonDisabled = true;
                $http.post(API.payment + '/pay/' + encodeURIComponent($scope.data.uniqueid), $scope.data.cart, { skipLoader: true })
                    .then(function(res) {
                        $scope.data.message = 'Order reference ' + res.data.orderid;
                        angular.copy({ total: 0, tax: 0, items: [] }, currentUser.cart);
                        $scope.data.cart = currentUser.cart;
                        $scope.data.cont = true;
                        toast.success('Order placed');
                    })
                    .catch(function(e) {
                        toast.error(apiError(e, 'We could not place your order'));
                        $scope.data.buttonDisabled = false;
                    });
            };
        }
    ]);

    /* ------------------------------------------------------------------ *
     * Auth page controllers
     * ------------------------------------------------------------------ */

    function passwordScore(password) {
        if (!password) return 0;
        var score = 0;
        if (password.length >= 8) score++;
        if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
        if (/[0-9]/.test(password)) score++;
        if (/[^A-Za-z0-9]/.test(password)) score++;
        if (password.length >= 14 && score === 4) return 4;
        return Math.min(score, 4);
    }

    var STRENGTH_LABELS = ['Enter a password', 'Weak', 'Fair', 'Good', 'Strong'];

    function validatePassword(password) {
        if (!password) return 'Password is required';
        if (password.length < 8) return 'Use at least 8 characters';
        if (!/[a-z]/.test(password)) return 'Add a lowercase letter';
        if (!/[A-Z]/.test(password)) return 'Add an uppercase letter';
        if (!/[0-9]/.test(password)) return 'Add a digit';
        if (!/[^A-Za-z0-9]/.test(password)) return 'Add a symbol';
        return null;
    }

    var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
    var USERNAME_RE = /^[a-zA-Z0-9_.-]{3,30}$/;
    var PHONE_RE = /^\+?[0-9][0-9\s().\-]{6,19}$/;

    robotshop.controller('loginform', ['$scope', '$http', '$location', 'auth', 'currentUser', 'toast', 'apiError',
        function($scope, $http, $location, auth, currentUser, toast, apiError) {
            $scope.data = { email: '', password: '', remember: false, busy: false };
            $scope.errors = {};

            if (auth.isAuthenticated()) {
                $location.url('/profile');
            }

            $scope.login = function() {
                $scope.errors = {};
                if (!$scope.data.email || !$scope.data.email.trim()) {
                    $scope.errors.email = 'Email or username is required';
                }
                if (!$scope.data.password) {
                    $scope.errors.password = 'Password is required';
                }
                if (Object.keys($scope.errors).length) return;

                var anonymousId = currentUser.uniqueid;
                $scope.data.busy = true;
                auth.login({
                    email: $scope.data.email.trim(),
                    password: $scope.data.password,
                    remember: $scope.data.remember
                }).then(function(user) {
                    $scope.data.password = '';
                    toast.success('Welcome back, ' + user.name);
                    // carry the anonymous cart over to the signed in identity
                    if (anonymousId && anonymousId !== user.name) {
                        $http.get(API.cart + '/rename/' + encodeURIComponent(anonymousId) + '/' +
                            encodeURIComponent(user.name), { skipLoader: true })
                            .then(function(res) { angular.copy(res.data, currentUser.cart); })
                            .catch(function() { /* no anonymous cart to move */ });
                    }
                    $location.url('/profile');
                }).catch(function(e) {
                    $scope.data.password = '';
                    var msg = apiError(e, 'Sign in failed');
                    $scope.errors.password = msg;
                    toast.error(msg);
                }).finally(function() {
                    $scope.data.busy = false;
                });
            };
        }
    ]);

    robotshop.controller('registerform', ['$scope', '$http', '$location', 'auth', 'toast', 'apiError',
        function($scope, $http, $location, auth, toast, apiError) {
            $scope.data = {
                firstName: '', lastName: '', name: '', email: '', phone: '',
                password: '', confirmPassword: '',
                strength: 0, strengthLabel: STRENGTH_LABELS[0],
                usernameOk: false, emailOk: false, busy: false
            };
            $scope.errors = {};

            $scope.scorePassword = function() {
                $scope.data.strength = passwordScore($scope.data.password);
                $scope.data.strengthLabel = STRENGTH_LABELS[$scope.data.strength];
            };

            $scope.checkUsername = function() {
                $scope.data.usernameOk = false;
                var name = ($scope.data.name || '').trim();
                if (!USERNAME_RE.test(name)) return;
                $http.get(API.user + '/available/username/' + encodeURIComponent(name), { skipLoader: true })
                    .then(function(res) {
                        $scope.data.usernameOk = res.data.available;
                        $scope.errors.name = res.data.available ? null : 'That username is taken';
                    })
                    .catch(function() { /* availability is advisory only */ });
            };

            $scope.checkEmail = function() {
                $scope.data.emailOk = false;
                var email = ($scope.data.email || '').trim().toLowerCase();
                if (!EMAIL_RE.test(email)) return;
                $http.get(API.user + '/available/email/' + encodeURIComponent(email), { skipLoader: true })
                    .then(function(res) {
                        $scope.data.emailOk = res.data.available;
                        $scope.errors.email = res.data.available ? null : 'That email is already registered';
                    })
                    .catch(function() { /* availability is advisory only */ });
            };

            function validate() {
                var e = {};
                var d = $scope.data;
                if (!d.firstName || !d.firstName.trim()) e.firstName = 'First name is required';
                if (!d.lastName || !d.lastName.trim()) e.lastName = 'Last name is required';
                if (!USERNAME_RE.test((d.name || '').trim())) e.name = '3-30 characters: letters, digits, . _ -';
                if (!EMAIL_RE.test((d.email || '').trim())) e.email = 'Enter a valid email address';
                if (!PHONE_RE.test((d.phone || '').trim())) e.phone = 'Enter a valid phone number';
                var pw = validatePassword(d.password);
                if (pw) e.password = pw;
                if (d.password !== d.confirmPassword) e.confirmPassword = 'Passwords do not match';
                $scope.errors = e;
                return Object.keys(e).length === 0;
            }

            $scope.register = function() {
                if (!validate()) {
                    toast.error('Please fix the highlighted fields');
                    return;
                }
                $scope.data.busy = true;
                auth.register({
                    firstName: $scope.data.firstName.trim(),
                    lastName: $scope.data.lastName.trim(),
                    name: $scope.data.name.trim(),
                    email: $scope.data.email.trim().toLowerCase(),
                    phone: $scope.data.phone.trim(),
                    password: $scope.data.password,
                    confirmPassword: $scope.data.confirmPassword
                }).then(function(user) {
                    toast.success('Welcome aboard, ' + user.name);
                    $location.url('/profile');
                }).catch(function(e) {
                    var msg = apiError(e, 'Registration failed');
                    if (e.data && e.data.field === 'email') $scope.errors.email = msg;
                    else if (e.data && e.data.field === 'username') $scope.errors.name = msg;
                    toast.error(msg);
                }).finally(function() {
                    $scope.data.busy = false;
                });
            };
        }
    ]);

    robotshop.controller('forgotform', ['$scope', '$http', 'toast', 'apiError',
        function($scope, $http, toast, apiError) {
            $scope.data = { email: '', busy: false, issued: false, resetToken: '' };
            $scope.errors = {};

            $scope.requestReset = function() {
                $scope.errors = {};
                if (!EMAIL_RE.test(($scope.data.email || '').trim())) {
                    $scope.errors.email = 'Enter a valid email address';
                    return;
                }
                $scope.data.busy = true;
                $http.post(API.user + '/forgot-password', { email: $scope.data.email.trim().toLowerCase() }, { skipLoader: true })
                    .then(function(res) {
                        $scope.data.issued = true;
                        $scope.data.resetToken = res.data.resetToken || '';
                        toast.success('Reset request sent');
                    })
                    .catch(function(e) { toast.error(apiError(e, 'Could not start the reset')); })
                    .finally(function() { $scope.data.busy = false; });
            };
        }
    ]);

    robotshop.controller('resetform', ['$scope', '$http', '$location', 'toast', 'apiError',
        function($scope, $http, $location, toast, apiError) {
            $scope.data = {
                token: $location.search().token || '',
                password: '', confirmPassword: '', busy: false,
                strength: 0, strengthLabel: STRENGTH_LABELS[0]
            };
            $scope.errors = {};

            $scope.scorePassword = function() {
                $scope.data.strength = passwordScore($scope.data.password);
                $scope.data.strengthLabel = STRENGTH_LABELS[$scope.data.strength];
            };

            $scope.resetPassword = function() {
                var e = {};
                if (!$scope.data.token.trim()) e.token = 'Reset token is required';
                var pw = validatePassword($scope.data.password);
                if (pw) e.password = pw;
                if ($scope.data.password !== $scope.data.confirmPassword) e.confirmPassword = 'Passwords do not match';
                $scope.errors = e;
                if (Object.keys(e).length) return;

                $scope.data.busy = true;
                $http.post(API.user + '/reset-password', {
                    token: $scope.data.token.trim(),
                    password: $scope.data.password
                }, { skipLoader: true }).then(function() {
                    toast.success('Password updated, please sign in');
                    $location.url('/login');
                }).catch(function(err) {
                    toast.error(apiError(err, 'Could not reset your password'));
                }).finally(function() {
                    $scope.data.busy = false;
                });
            };
        }
    ]);

    robotshop.controller('profileform', ['$scope', '$http', 'auth', 'toast', 'apiError',
        function($scope, $http, auth, toast, apiError) {
            var user = auth.user() || {};
            $scope.data = {
                user: user,
                form: { firstName: user.firstName, lastName: user.lastName, phone: user.phone },
                pw: { current: '', next: '', confirm: '' },
                busy: false, pwBusy: false,
                strength: 0, strengthLabel: STRENGTH_LABELS[0]
            };

            $scope.scorePassword = function() {
                $scope.data.strength = passwordScore($scope.data.pw.next);
                $scope.data.strengthLabel = STRENGTH_LABELS[$scope.data.strength];
            };

            $scope.saveProfile = function() {
                $scope.data.busy = true;
                $http.put(API.user + '/me', $scope.data.form, { skipLoader: true }).then(function(res) {
                    $scope.data.user = res.data.user;
                    auth.updateUser(res.data.user);
                    toast.success('Profile updated');
                }).catch(function(e) {
                    toast.error(apiError(e, 'Could not save your profile'));
                }).finally(function() {
                    $scope.data.busy = false;
                });
            };

            $scope.changePassword = function() {
                var problem = validatePassword($scope.data.pw.next);
                if (problem) { toast.error(problem); return; }
                if ($scope.data.pw.next !== $scope.data.pw.confirm) {
                    toast.error('Passwords do not match');
                    return;
                }
                $scope.data.pwBusy = true;
                $http.post(API.user + '/change-password', {
                    currentPassword: $scope.data.pw.current,
                    newPassword: $scope.data.pw.next
                }, { skipLoader: true }).then(function() {
                    $scope.data.pw = { current: '', next: '', confirm: '' };
                    toast.success('Password updated, please sign in again');
                    auth.logout(true);
                }).catch(function(e) {
                    toast.error(apiError(e, 'Could not change your password'));
                }).finally(function() {
                    $scope.data.pwBusy = false;
                });
            };

            // refresh from the server so the page always shows canonical data
            $http.get(API.user + '/me', { skipLoader: true }).then(function(res) {
                $scope.data.user = res.data.user;
                $scope.data.form = {
                    firstName: res.data.user.firstName,
                    lastName: res.data.user.lastName,
                    phone: res.data.user.phone
                };
                auth.updateUser(res.data.user);
            }).catch(function() { /* interceptor handles auth failures */ });
        }
    ]);

    robotshop.controller('ordersform', ['$scope', '$http', 'toast', 'apiError',
        function($scope, $http, toast, apiError) {
            $scope.data = { orders: [], loading: true };

            $http.get(API.user + '/orders', { skipLoader: true }).then(function(res) {
                $scope.data.orders = (res.data.history || []).slice().reverse();
            }).catch(function(e) {
                if (e.status !== 401) toast.error(apiError(e, 'Could not load your orders'));
            }).finally(function() {
                $scope.data.loading = false;
            });
        }
    ]);

})(window.angular);
